# Vite CJS compatibility for local deps

## Problem

When a pds-managed dependency is switched to local (`pds l <pkg>`), Vite may fail to serve it because:

1. **CJS modules**: Local packages often have CJS source (`require()`). Vite serves local/linked packages raw (bypasses `optimizeDeps`), so CJS `require()` fails in the browser.
2. **Node.js globals**: Packages (or their transitive deps) reference `global`, `Buffer`, `process`, etc. which don't exist in the browser.
3. **esbuild resolution**: The local package's build tools may resolve to the consumer's workspace `node_modules` instead of their own, causing mismatched platform configs.

These issues don't occur with npm/GH dist versions because those are pre-bundled.

## Implementation

Extended `pdsPlugin` in `src/vite.ts` to auto-detect and fix these issues:

### 1. Auto-include local deps in `optimizeDeps.include`

All local deps (those with `localPath` set) are added to `optimizeDeps.include`, so Vite pre-bundles them (CJS→ESM conversion). This counteracts `pds local` adding them to `optimizeDeps.exclude` in vite.config.ts.

### 2. Auto-define `global` for CJS local deps

CJS detection: `!localPkg.type || localPkg.type !== 'module'`. When any local dep is CJS, the plugin adds `define: { global: 'globalThis' }`. This is safe — `globalThis` is the standard browser equivalent of Node's `global`.

Chose not to add `process.env.NODE_ENV` shim (as originally proposed) since Vite already handles that via its own `define` defaults.

### 3. `optimizeDeps.exclude` conflict

Not explicitly handled at the plugin level. The `optimizeDeps.include` from the plugin takes precedence — Vite's merge behavior means `include` wins over `exclude` for the same package. If issues arise, the consumer can remove the dep from their manual `exclude` list.

## Non-goals

- Don't shim `Buffer`, `stream`, `fs`, etc. — those are actual Node APIs that need polyfills, which is a consumer decision
- Don't modify the local package's build — that's the package's responsibility

## Files changed

| File | Change |
|------|--------|
| `src/vite.ts` | Added `optimizeDeps.include` for local deps, `define.global` shim for CJS deps, `LocalDepInfo` tracking |
| `test/vite-plugin.test.ts` | Added 7 CJS compat tests (optimizeDeps, global shim, ESM skip, mixed CJS/ESM) |
