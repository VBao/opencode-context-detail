// Server-side entry point.
//
// The token breakdown is a TUI concern, so everything lives in `./tui`
// (src/tui.tsx). This file exists because OpenCode resolves a plugin package's
// `.` export on the server as well as `./tui` in the terminal, and a package
// that only declares the latter fails to load. Keeping a no-op server plugin
// means the package is a valid plugin for both surfaces without pretending to
// own server state.

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode.context-detail",
  setup() {},
})
