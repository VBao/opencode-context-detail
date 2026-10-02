// Root re-export so the directory resolves when opencode.json(c) points at
// this folder by path (e.g. "/abs/path/to/opencode-context-detail").
//
// The local-path loader looks for an entry file at the directory root, so a
// package laid out as `src/` + an `exports` map only resolves once installed
// from the registry. These stubs bridge the two: the npm `exports` map in
// package.json still points at ./src/*, and these files forward there for
// path-based loading. No logic lives here.

export { default } from "./src/index.ts"
