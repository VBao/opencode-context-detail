# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-02

First packaged release. The plugin existed as a single file in a local
`plugins/` directory before this; the behaviour is unchanged.

### Added

- `sidebar.content` contribution rendering a colorized context bar and a
  per-kind token breakdown (input, output, reasoning, cache read, cache write),
  split into a latest-call section and a whole-session section.
- `/context-detail` command, also in the command palette, toggling the `sum` and
  `detail` views. Persisted in plugin storage.
- `defaultView` and `debug` plugin options.
- Request total sourced from the server when the loaded message window no
  longer contains the user message that opened the request.
- Revert-aware counting, so the context number matches the visible transcript
  after an undo.
- No-op server entry (`src/index.ts`) so the package resolves on both the server
  and the TUI.

[Unreleased]: https://github.com/OWNER/opencode-context-detail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/opencode-context-detail/releases/tag/v0.1.0
