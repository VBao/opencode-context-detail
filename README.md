# context-detail

[![typecheck](https://github.com/VBao/opencode-context-detail/actions/workflows/typecheck.yml/badge.svg)](https://github.com/VBao/opencode-context-detail/actions/workflows/typecheck.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A colorized context and cost breakdown in the OpenCode TUI sidebar, split by
token kind.

OpenCode's built-in sidebar shows one line:

```
Context 13,863 tokens 1% used
```

This plugin replaces that line with the same context number, a color bar, and a
per-kind breakdown of where the tokens went — which is usually the question
when you are watching a context bar climb.

```
Context 94,722 / 1,048,576  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░
input (new)      44 / 44
cache read  94,524 / 94,568
output          154 / 154
reasoning         0 / 0
Space Bunny Free
input (new)  140,426
output         14,431
reasoning      13,315
cache read 3,339,880
session          3.5M tok
last turn            2.4s
session cost      $0.00
```

## Install

Add the package to `plugins` in **`cli.json`** (the TUI config, not
`opencode.jsonc`), together with the entry that disables the built-in line:

```jsonc title="~/.config/opencode/cli.json"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-context-detail", "-opencode.sidebar.context"]
}
```

> **The `-opencode.sidebar.context` entry is required.** Without it OpenCode
> still renders its own line and you get the same context number twice. Prefix
> any plugin entry with `-` to disable it; drop the entry to get the built-in
> line back.

This is a CLI-only plugin. It belongs in `cli.json` rather than
`opencode.jsonc` so it stays active against a remote server.

Options can be passed with the object form:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-context-detail",
      "options": { "defaultView": "sum" }
    },
    "-opencode.sidebar.context"
  ]
}
```

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `defaultView` | `"sum"` \| `"detail"` | `"detail"` | Seeds the view on first run. `sum` shows each kind's share of the call; `detail` shows exact counts. The `/context-detail` toggle overrides it from then on. |
| `debug` | `boolean` | `false` | Appends a JSON line per render to `<tmpdir>/context-detail.log`. Same as `CONTEXT_DETAIL_DEBUG=1`. |

## Commands

| Command | Effect |
| --- | --- |
| `/context-detail` | Toggle between the `sum` and `detail` views. Also in the command palette. The choice is stored per plugin and survives restarts. |

## What the two breakdowns mean

The sidebar shows two sets of numbers, divided by the model name line. They come
from different sources on purpose.

**Above the model name — the latest completed model call.** The `Context` row,
the bar, and the kind rows. These add up to the `Context` row and stay inside
the model's context window. Each kind row reads `turn / request`, where the
request is every turn since you last sent a message. The left number is this
turn; the right is the whole in-flight request.

**Below the model name — the whole session.** The same kinds, taken from the
session's own token aggregate, closed by the `session` total row. OpenCode
maintains that aggregate as messages complete, so this needs no message fan-out.

The `/` reads the same way in both places but means different things: on the
`Context` row it is `used / window limit`; on a kind row it is
`this turn / since your last message`.

Rows whose value is zero are hidden in `sum` view, except `cache write`, which
is always hidden when zero — many providers never report cache writes, so a
permanent zero row is noise. Turn cost is only shown once it reaches $0.01,
since a free or unpriced model would otherwise read as `$0.00` next to the
elapsed time.

## Data sources

Everything comes from state the TUI has already synced, so the common case
costs no extra API calls:

| Source | Provides |
| --- | --- |
| `data.session.message.list(id)` | last completed assistant message; request total while your last user message is inside the loaded window |
| `client` | request total otherwise — the window only holds the newest `initialMessageLimit` messages (default 20) and widens on scroll, so a long request can push your message out of it |
| `data.session.get(id)` | session-wide per-kind tokens, cost, model, revert point |
| `data.location.model.list(loc)` | `limit.context` for the model that ran the last turn |

When the request total has to come from the server it is paged newest-first
until it reaches the user message that opened the request. A reverted session
stops counting at the revert point, so the context number matches what is
actually on screen after an undo.

## Development

```sh
bun install
bun run typecheck
```

Ship as raw TypeScript — OpenCode transpiles plugin sources at load time, so
there is no build step and no `dist/`.

To try it against a local checkout, point `cli.json` at the directory instead of
the package name:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-context-detail", "-opencode.sidebar.context"] }
```

> **Local paths and npm packages resolve differently.** When `cli.json` points
> at a *directory*, OpenCode looks for an entry file at that directory's root
> (`tui.tsx`, `tui.js`, `index.ts`, `index.js`) — it does not read the package
> `exports` map. That is why the root `index.ts` and `tui.tsx` exist as
> re-export stubs over `src/`. Without them a `src/` layout silently resolves
> nothing, and because `-opencode.sidebar.context` suppresses the built-in line
> the sidebar just goes blank.

Use `opencode --standalone` to run the TUI against a private server, which
isolates plugin behaviour from your shared background service.

## Compatibility

Verified against **OpenCode 2.0.21**, the release this was last checked at
runtime. The dependency floor is `2.0.19`. CI additionally typechecks `2.0.20`,
`2.0.22` and `latest`, since the plugin depends on TUI slot paths
(`sidebar.content`, `app`) and the `data.session.*` / `data.location.*` context
APIs, both of which are OpenCode-version-specific.

## License

MIT
