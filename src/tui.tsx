// context-detail — a colorized context / cost breakdown in the TUI sidebar.
//
// Replaces the built-in `opencode.sidebar.context` line in the `sidebar.content`
// slot with the same context number, a color bar, and a per-kind breakdown.
// See README.md for the full design notes and install steps.
//
// Two breakdowns, divided by the model name line:
//   above  the latest completed model call — the Context row, the color bar and
//          the kind rows. They add up to the Context row and stay inside the
//          model's context window. Each kind row reads `turn / request`.
//   below  the whole session — the same kinds from the session's own token
//          aggregate, closed by the `session` total row.
//
// The `/` on a kind row means `this turn / since your last message`; on the
// Context row it means `used / window limit`.
//
// Two views, toggled with /context-detail: `sum` shows each kind's share of the
// call's tokens, `detail` shows exact counts. The choice lives in plugin
// storage, so it survives restarts.
//
// Requires "-opencode.sidebar.context" in the `plugins` array of cli.json, or
// the built-in line renders the same number a second time.
//
// CONTEXT_DETAIL_DEBUG=1 traces every render to <tmpdir>/context-detail.log.
//
// Verified against OpenCode 2.0.21.

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Fallback bar width, used only until the sidebar has been measured.
const BAR = 24
const STORE = "context-detail"

// Plugin options, all optional. `defaultView` seeds storage on first run only —
// after that the /context-detail toggle owns the value. `debug` forces the
// trace on without the env var, for users who would rather not export one.
function initialSettings(options) {
  return { detail: options?.defaultView !== "sum" }
}

function debugEnabled(options) {
  return options?.debug === true || process.env.CONTEXT_DETAIL_DEBUG === "1"
}

// One color per token kind, reused for the label, the value and that kind's
// slice of the bar so a kind is identifiable at a glance. Fixed hexes rather
// than theme tokens on purpose: `theme.categorical` is theme dependent and can
// be as short as two entries, and `theme.text.feedback` is not semantically
// sane on every theme (the system theme maps success to a dark red).
// These are mid-tones that read on both light and dark backgrounds, so they
// stay legible whatever theme the user is running.
const KINDS = [
  { key: "input", label: "input (new)", color: "#5ac8fa" },
  { key: "output", label: "output", color: "#82dc6e" },
  { key: "reasoning", label: "reasoning", color: "#ffb454" },
  { key: "cacheRead", label: "cache read", color: "#c792ea" },
  { key: "cacheWrite", label: "cache write", color: "#e879f9" },
]

const FILLED = "█"

const exact = new Intl.NumberFormat("en-US")
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function valueOf(tokens, key) {
  if (key === "cacheRead") return tokens.cache?.read ?? 0
  if (key === "cacheWrite") return tokens.cache?.write ?? 0
  return tokens[key] ?? 0
}

function total(tokens) {
  return KINDS.reduce((sum, kind) => sum + valueOf(tokens, kind.key), 0)
}

// Mirrors the shape of `message.tokens` / the session aggregate. Every field is
// optional on the wire, so reads go through `valueOf` rather than direct access.
type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

// One contiguous stretch of the bar, rendered as a single colored span.
type BarRun = { char: string; fg: string }

// A sidebar line. Exactly one of `bar` / `line` / (`label` + `value`) is set;
// the renderer picks between them, so all are optional here.
type Row = {
  label?: string
  value?: string
  line?: string
  bar?: BarRun[]
  fg?: string
}

// A zeroed counter shaped like `message.tokens`, so `valueOf` and `addTo` work
// on an aggregate exactly as they do on a single message.
function zero(): Required<Tokens> & { cache: Required<Tokens["cache"]> } {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTo(sum: ReturnType<typeof zero>, tokens: Tokens) {
  sum.input += tokens.input ?? 0
  sum.output += tokens.output ?? 0
  sum.reasoning += tokens.reasoning ?? 0
  sum.cache.read += tokens.cache?.read ?? 0
  sum.cache.write += tokens.cache?.write ?? 0
  return sum
}

function duration(message) {
  const start = message?.time?.created
  const end = message?.time?.completed
  if (typeof start !== "number" || typeof end !== "number") return undefined
  const ms = end - start
  if (ms < 0) return undefined
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function share(value, sum) {
  if (sum <= 0) return "0%"
  const ratio = value / sum
  if (ratio < 0.001) return "<0.1%"
  return `${(ratio * 100).toFixed(1)}%`
}

// One request = every turn between your last message and the newest turn. The
// TUI only loads the newest N messages (default 20) and widens that window as
// the transcript is scrolled, so a long request can push your message out of
// it. This walks the server's copy instead. Pages come back newest-first and
// `cursor.next` walks further back, so one pass down to the user message that
// opened the request collects the whole thing. Synthetic and system messages
// carry no `tokens`, so only assistant turns add up; the first `user` message
// is the boundary. `revertID` is counted, then stops — matching visibleEnd().
async function sumRequest(client, sessionID, revertID) {
  const sum = zero()
  let cursor
  for (;;) {
    const page = await client.session.message.list({
      sessionID,
      limit: 50,
      // The endpoint rejects `order` alongside a cursor, and the cursor already
      // encodes the direction, so only the first page asks to be newest-first.
      ...(cursor ? { cursor } : { order: "desc" }),
    })
    for (const message of page.data ?? []) {
      if (message?.type === "user") return sum
      if (message?.type === "assistant" && message.tokens) addTo(sum, message.tokens)
      if (revertID && message?.id === revertID) return sum
    }
    cursor = page.cursor?.next
    if (!cursor) return sum
  }
}

// The bar is the composition of the turn's tokens: each kind's slice is
// proportional to its token count. Largest remainder allocation, so the slices
// always add up to exactly `cells` wide instead of losing a cell to flooring.
function barRuns(tokens, sum, cells) {
  const present = KINDS.map((kind) => ({ ...kind, value: valueOf(tokens, kind.key) })).filter(
    (kind) => kind.value > 0,
  )
  if (present.length === 0 || cells <= 0) return []

  const exactCells = present.map((kind) => (kind.value / sum) * cells)
  const counts = exactCells.map(Math.floor)
  let spare = cells - counts.reduce((sum, count) => sum + count, 0)
  const byRemainder = exactCells
    .map((value, index) => ({ index, rest: value - counts[index] }))
    .sort((a, b) => b.rest - a.rest)
  for (const { index } of byRemainder) {
    if (spare <= 0) break
    counts[index] += 1
    spare -= 1
  }

  // Merge neighbouring cells of the same kind so the bar is a handful of
  // spans rather than one per column.
  const runs: BarRun[] = []
  present.forEach((kind, index) => {
    if (counts[index] <= 0) return
    runs.push({ char: FILLED.repeat(counts[index]), fg: kind.color })
  })
  return runs
}

function ContextDetail(props) {
  const context = usePlugin()
  const theme = context.theme
  const [settings] = context.storage.store(STORE, { initial: initialSettings(context.options) })
  const [sidebarWidth, setSidebarWidth] = createSignal(0)

  const session = createMemo(() => context.data.session.get(props.sessionID))
  const messages = createMemo(() => context.data.session.message.list(props.sessionID) ?? [])
  const location = createMemo(() => session()?.location ?? context.data.location.default())
  const models = createMemo(() => context.data.location.model.list(location()) ?? [])

  // A reverted session's live context stops at the message it was reverted to,
  // so nothing after that message counts. `last` and the request total both
  // read this, so they agree after an undo.
  const visibleEnd = createMemo(() => {
    const all = messages()
    const revertID = session()?.revert?.messageID
    if (!revertID) return all.length
    const index = all.findIndex((message) => message?.id === revertID)
    return index === -1 ? all.length : index + 1
  })

  // The last completed assistant message is the one whose token counts
  // describe the context window that was actually sent. In-flight messages
  // carry no `tokens` yet.
  const last = createMemo(() => {
    const all = messages()
    const end = visibleEnd()
    for (let i = end - 1; i >= 0; i--) {
      const message = all[i]
      if (message?.type === "assistant" && message.tokens) return message
    }
    return undefined
  })

  // Every turn since you last sent a message, read straight from the loaded
  // transcript. `complete` is false when the window holds no user message at
  // all, which either means the session genuinely has none (a delegated
  // subagent) or that your message is older than the window — the two are
  // indistinguishable here, so fall through to sumRequest() to tell them
  // apart rather than silently reporting the window as the request.
  const requestFromWindow = createMemo(() => {
    const all = messages()
    const end = visibleEnd()
    let start = 0
    let complete = false
    for (let i = end - 1; i >= 0; i--) {
      if (all[i]?.type === "user") {
        start = i + 1
        complete = true
        break
      }
    }
    const sum = zero()
    for (let i = start; i < end; i++) {
      const message = all[i]
      if (message?.type === "assistant" && message.tokens) addTo(sum, message.tokens)
    }
    return { tokens: sum, complete, empty: end === 0 }
  })

  // The server's answer, held per boundary. Keyed on the newest counted message
  // so it re-reads once per turn and holds still otherwise. The annotation is
  // load-bearing: without it the literal narrows both fields to `undefined` and
  // the first real assignment no longer typechecks.
  const [fetched, setFetched] = createSignal<{ key: string | undefined; tokens: Tokens | undefined }>({
    key: undefined,
    tokens: undefined,
  })

  const requestKey = createMemo(() => {
    const all = messages()
    const end = visibleEnd()
    return `${props.sessionID}|${all[end - 1]?.id ?? ""}|${session()?.revert?.messageID ?? ""}`
  })

  createEffect(() => {
    const win = requestFromWindow()
    if (win.complete || win.empty) return
    const key = requestKey()
    if (fetched().key === key) return
    const client = context.client
    if (!client) return
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    void sumRequest(client, props.sessionID, session()?.revert?.messageID)
      .then((tokens) => {
        if (!cancelled) setFetched({ key, tokens })
      })
      .catch(() => {
        // Keep the window's number rather than blanking the row.
        if (!cancelled) setFetched({ key, tokens: undefined })
      })
  })

  // Window first (no I/O), then the server's answer once it lands. A request
  // that overflows the window therefore reports a partial sum for the frame or
  // two the round-trip takes, then corrects itself.
  const requestTokens = createMemo(() => {
    const win = requestFromWindow()
    if (win.complete) return win.tokens
    const hit = fetched()
    if (hit.key === requestKey()) return hit.tokens ?? win.tokens
    return win.tokens
  })

  const requestSource = createMemo(() => {
    if (requestFromWindow().complete) return "window"
    return fetched().key === requestKey() ? "server" : "window-partial"
  })

  const model = createMemo(() => {
    const used = last()?.model
    if (!used) return undefined
    return models().find(
      (entry) => entry.providerID === used.providerID && (entry.id === used.id || entry.modelID === used.id),
    )
  })

  const limit = createMemo(() => model()?.limit)
  const contextLimit = createMemo(() => {
    const value = limit()?.context
    return typeof value === "number" && value > 0 ? value : undefined
  })

  const usedTokens = createMemo(() => {
    const tokens = last()?.tokens
    if (!tokens) return undefined
    return total(tokens)
  })

  // Per-kind session totals come straight from the session's own aggregate,
  // which OpenCode maintains as messages complete — no message fan-out.
  const sessionTokens = createMemo(() => session()?.tokens)

  const percent = createMemo(() => {
    const used = usedTokens()
    const max = contextLimit()
    if (used === undefined || !max) return undefined
    return Math.round((used / max) * 100)
  })

  const usedColor = createMemo(() => {
    const value = percent()
    if (value === undefined) return theme.text.base
    if (value >= 95) return theme.text.feedback.error.base
    if (value >= 80) return theme.text.feedback.warning.base
    return theme.text.base
  })

  // The bar is the color breakdown of the latest call's tokens — the same
  // numbers as the rows below, so the section stays window-sized (the
  // cumulative total lives in the `session` row).
  const barCells = createMemo(() => {
    const tokens = last()?.tokens
    if (!tokens) return []
    const used = total(tokens)
    if (used <= 0) return []
    const width = Math.max(1, sidebarWidth() > 0 ? sidebarWidth() : BAR)
    return barRuns(tokens, used, width)
  })

  const sessionCost = createMemo(() => {
    const value = context.data.session.cost(props.sessionID)
    return typeof value === "number" ? value : (session()?.cost ?? 0)
  })

  // Two row shapes: a label flush left paired with its value flush right, or a
  // single free-form line for values (model name) that span the whole width.
  const rows = createMemo(() => {
    const tokens = last()?.tokens
    if (!tokens) return []
    const out: Row[] = []
    const used = usedTokens() ?? 0
    const max = contextLimit()
    const detail = settings.detail === true
    const aggregate = sessionTokens()
    const sessionTotal = aggregate ? total(aggregate) : 0

    if (max) {
      out.push({
        label: "Context",
        value: `${exact.format(used)} / ${exact.format(max)}`,
        fg: usedColor(),
      })
    } else {
      out.push({ label: "Context", value: exact.format(used) })
    }

    out.push({ bar: barCells() })

    // `turn / request` — the left side is today's value, the right side every
    // turn since your last message, so a row of tool-call turns reads as one
    // request instead of a column of unrelated numbers.
    const request = requestTokens()
    const requestUsed = total(request)

    for (const kind of KINDS) {
      const value = valueOf(tokens, kind.key)
      // A kind that never appears costs a row but says nothing; skip it.
      if (!value && !detail) continue
      if (kind.key === "cacheWrite" && !value) continue
      out.push({
        label: kind.label,
        value: `${detail ? exact.format(value) : share(value, used)} / ${
          detail ? exact.format(valueOf(request, kind.key)) : share(valueOf(request, kind.key), requestUsed)
        }`,
        fg: kind.color,
      })
    }

    const entry = model()
    const variant = last()?.model?.variant
    if (entry) {
      out.push({ line: `${entry.name ?? entry.id}${variant ? ` · ${variant}` : ""}` })
    }

    // The same kinds again, this time summed over the whole session — the
    // numbers below the model name are the only cumulative ones.
    if (aggregate) {
      for (const kind of KINDS) {
        const value = valueOf(aggregate, kind.key)
        if (!value && !detail) continue
        if (kind.key === "cacheWrite" && !value) continue
        out.push({
          label: kind.label,
          value: detail ? exact.format(value) : share(value, sessionTotal),
          fg: kind.color,
        })
      }
    }

    if (detail && sessionTotal > 0) {
      out.push({ label: "session", value: `${compact.format(sessionTotal)} tok` })
    }

    const elapsed = duration(last())
    if (elapsed) {
      // A turn that rounds to $0.00 (free or unpriced model) reads as noise
      // next to the elapsed time, so only append the cost once it is worth
      // showing.
      const turn = last()?.cost
      out.push({
        label: "last turn",
        value: typeof turn === "number" && turn >= 0.01 ? `${elapsed} ${usd.format(turn)}` : elapsed,
      })
    }

    out.push({ label: "session cost", value: usd.format(sessionCost()) })

    return out
  })

  if (debugEnabled(context.options)) {
    createEffect(() => {
      try {
        appendFileSync(
          join(tmpdir(), "context-detail.log"),
          JSON.stringify({
            at: new Date().toISOString(),
            mode: settings.detail ? "detail" : "sum",
            listLength: models().length,
            messageModel: last()?.model,
            matchedLimit: model()?.limit,
            bar: barCells().map((run) => `${run.char.length}${run.fg}`),
            rowCount: rows().length,
            // The TUI loads only the newest `initialMessageLimit` messages
            // (default 20) and widens the window on scroll, so messageCount
            // against the real total is what says whether the request sum
            // came from the window or needed the server.
            messageCount: messages().length,
            visibleEnd: visibleEnd(),
            requestSource: requestSource(),
            requestTotal: total(requestTokens()),
          }) + "\n",
        )
      } catch {}
    })
  }

  return (
    <box
      id="sidebar.context-detail"
      flexDirection="column"
      flexShrink={0}
      gap={0}
      ref={(element) => {
        // The host owns the sidebar's width; read it back from the laid-out
        // box so the bar can fill it and keep filling it after a resize.
        element.onSizeChange = () => {
          const width = element.width
          if (typeof width === "number" && width > 0) setSidebarWidth(width)
        }
      }}
    >
      <Show when={rows().length > 0}>
        <For each={rows()}>
          {(row) => (
            <Show when={row.bar !== undefined} fallback={
              <Show
                when={row.line !== undefined}
                fallback={
                  // Label flush left, value flush right against the sidebar's
                  // width, so the numbers line up regardless of length (the
                  // joined output/cap value is wider than the old fixed column).
                  <box flexDirection="row" justifyContent="space-between" width="100%">
                    <text fg={row.fg ?? theme.text.muted} wrapMode="none">
                      {row.label ?? ""}
                    </text>
                    <text fg={row.fg ?? theme.text.base} wrapMode="none">
                      {row.value ?? ""}
                    </text>
                  </box>
                }
              >
                <text fg={row.fg ?? theme.text.base} wrapMode="none">
                  {row.line}
                </text>
              </Show>
            }>
              {/* A span takes its color from `style`, not a direct `fg` prop —
                  a direct `fg` on a span is silently ignored and the segment
                  comes out in the default text color. */}
              <text wrapMode="none">
                <For each={row.bar}>
                  {(run) => <span style={{ fg: run.fg }}>{run.char}</span>}
                </For>
              </text>
            </Show>
          )}
        </For>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.context-detail",
  setup(ctx) {
    const [settings, setSettings] = ctx.storage.store(STORE, { initial: initialSettings(ctx.options) })

    const off = ctx.ui.slot({
      prepend: "sidebar.content",
      render: (input) => <ContextDetail sessionID={input.sessionID} />,
    })

    // Keymap layers need a component scope, so the command is registered from
    // a slot render rather than directly in setup().
    const offCommand = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode.context-detail.toggle",
              title: "Context sidebar: summary or detail",
              group: "Context",
              slash: { name: "context-detail" },
              palette: true,
              suggested: true,
              run: () => {
                void setSettings((draft) => {
                  draft.detail = draft.detail === true ? false : true
                }).then(() =>
                  ctx.ui.toast.show({
                    title: "Context sidebar",
                    message: settings.detail === true ? "Showing detail" : "Showing summary",
                    duration: 2500,
                  }),
                )
              },
            },
          ],
        }))
        return null
      },
    })

    return () => {
      off?.()
      offCommand?.()
    }
  },
})
