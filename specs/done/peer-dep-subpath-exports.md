# `pdsPlugin`: alias peer dep subpath exports, not just package roots

## Problem

When `pds l <dep>` creates a workspace link, `pdsPlugin()` aliases the
linked dep's peer dependencies to the consuming project's `node_modules`
(preventing duplicate instances across the symlink boundary). But it
only aliases the **package root** — not subpath exports.

Example: pltly has `plotly.js` as a peerDep. Plugin creates:

```js
aliases['plotly.js'] = '/project/node_modules/plotly.js'
```

But `import('plotly.js/basic')` (a subpath export defined in plotly.js's
`exports` map) does NOT match the exact alias `plotly.js`. Vite falls
through to normal resolution, which is broken because the workspace
symlink has confused Vite's `.pnpm/` dep graph.

**This is the root cause of the recurring `pds l` breakage** that has
been worked around via:
- Switching the import to `plotly.js/lib/index-basic.js` (raw file path)
- Disabling `pdsPlugin()` entirely
- Manually adding `plotly.js/basic` alias in vite.config.ts
- Adding `plotly.js/basic` to `optimizeDeps.include`

None of these workarounds are durable. The fix belongs in pds.

## Current behavior

Lines 56-73 of `vite.js` only alias:
- `<peer>` → `node_modules/<peer>/` (root, exact match)
- Hardcoded special cases: `react/jsx-runtime`, `react-dom/client`

## Proposed fix

For every peer dep alias, read the peer dep's `package.json` `exports`
map and alias every subpath entry:

```js
const peerPkgPath = resolve(resolved, 'package.json');
if (existsSync(peerPkgPath)) {
    const peerPkg = JSON.parse(readFileSync(peerPkgPath, 'utf-8'));
    const peerExports = peerPkg.exports || {};
    for (const [key, target] of Object.entries(peerExports)) {
        if (key === '.' || key.includes('*')) continue;
        const subpath = key.startsWith('./')
            ? `${peer}/${key.slice(2)}`
            : `${peer}/${key}`;
        let targetPath;
        if (typeof target === 'string') targetPath = target;
        else if (target && typeof target === 'object') {
            targetPath = target.import ?? target.require ?? target.default;
        }
        if (targetPath) {
            aliases[subpath] = resolve(resolved, targetPath);
        }
    }
}
```

This also **replaces the hardcoded `react/jsx-runtime` and
`react-dom/client` special cases** — they become automatic from React's
exports map.

## Glob subpath exports

Exports maps can contain glob patterns like `"./dist/*": "./*"`. These
can't be represented as Vite aliases (which are exact-match strings).
Options:
- Skip globs (they're typically for internal/dist access, not primary
  API subpaths)
- Convert to Vite regex aliases: `{ find: /^plotly\.js\/dist\/(.*)$/,
  replacement: '<resolved>/$1' }`

Initial implementation should skip globs (the `key.includes('*')` guard
above); add regex support as a follow-up if needed.

## Test plan

Add to pds test suite (or manual test):

1. Project with local dep (pltly) that has peer dep (plotly.js) with
   exports map containing `"./basic": "./lib/index-basic.js"`
2. `pds l plt` → `pdsPlugin()` should produce aliases including
   `plotly.js/basic` → `/path/to/node_modules/plotly.js/lib/index-basic.js`
3. Vite dev server starts without `Failed to resolve import` error
4. `import('plotly.js/basic')` resolves and loads at runtime
5. `pds g plt` → `pdsPlugin()` no longer active (no local dep) →
   standard resolution works as before

## Why this keeps recurring

Every time a new subpath import is added (or an existing one is used in
a new context), the missing alias surfaces as a `Failed to resolve
import` error under `pds l`. Historically worked around per-project,
per-subpath. The generic fix handles all subpaths for all peer deps
automatically.

## Implementation notes

Implemented in `src/vite.ts`. The loop now reads each peer's
`package.json`, iterates `exports`, and aliases every non-glob,
non-root subpath. Supports both string targets (`"./x": "./y.js"`) and
conditional-object targets (resolves `import` → `require` → `default`).
Hardcoded `react/jsx-runtime` and `react-dom/client` special cases
removed; they're now handled automatically from React's exports map
(confirmed by updated unit tests in `test/vite-plugin.test.ts`).

Minor divergence from the spec's proposed snippet: the implementation
also skips keys that don't begin with `./` (Node's export-key spec
requires this form, so a non-conforming key is treated as invalid
rather than being coerced into `${peer}/${key}`).
