# Preserve sibling `optimizeDeps` keys on cleanup

## Problem

`pds l <pkg>` adds the package to `optimizeDeps.exclude` in `vite.config.ts`. When the consumer later runs `pds g <pkg>` (or `pds n <pkg>`, `pds gh <pkg>` — any switch that leaves `exclude` empty), pds removes the entry.

**Bug:** if removing the entry empties the `exclude` array, pds deletes the *entire* `optimizeDeps` block rather than just the (now empty) `exclude` key. This wipes out unrelated sibling keys the consumer added — in practice, `include: [...]`, `esbuildOptions`, etc. — that were never pds-managed.

### Concrete repro (observed in `~/c/hccs/path/www`)

1. User hand-authored in `vite.config.ts` (commit `80b4773`):
   ```ts
   optimizeDeps: {
     include: ['plotly.js/basic'],
   }
   ```
   Reason: dev-mode CJS→ESM pre-bundling for the dynamic `import('plotly.js/basic')` entry.

2. User ran `pds l plotly.js`. pds merged in `exclude`:
   ```ts
   optimizeDeps: {
     include: ['plotly.js/basic'],
     exclude: ['plotly.js'],
   }
   ```

3. User ran `pds g plotly.js`. pds removed `'plotly.js'` from `exclude`; the array became empty, and pds then deleted the **whole block** — losing `include` too.

Net: `pds l; pds g` is not a no-op on user config. Each round-trip erodes `optimizeDeps`.

## Root cause

`src/switch.ts` `updateViteConfig()`, ~lines 92–129. The empty-array cleanup path uses a single regex to remove the block:

```ts
new RegExp(`\\n${propIndent}optimizeDeps:\\s*\\{[\\s\\S]*?\\n${propIndent}\\},?\\n?`)
```

The `[\s\S]*?` matches *everything* between `optimizeDeps: {` and its closing brace, including sibling keys. There's no AST-level awareness of what's inside the block; if the block exists at all at the moment of cleanup, it's assumed to be pds's to delete.

## Fix

When removing the last pds-added entry from `optimizeDeps.exclude`:

1. **If `optimizeDeps` has other keys (`include`, `esbuildOptions`, `entries`, `force`, `extensions`, `holdUntilCrawlEnd`, etc.)** → remove only the `exclude` key (or leave it as `exclude: []` if removing is fiddly regex-wise; Vite treats them equivalently).
2. **If `optimizeDeps` only had `exclude`** → delete the whole block as today.

AST-based parsing (e.g. the `magicast` migration mentioned in `957fa0f`) would make this trivial; the current regex approach needs a pre-check for siblings before the block-delete regex fires.

Same concern applies symmetrically:
- On `pds l <pkg>` when `optimizeDeps` already exists with sibling keys, append `exclude` without overwriting.
- On `pds l <pkg>` when `exclude` already exists with unrelated entries, append to the existing array.

(Those two may already be handled — worth verifying while you're in the same function.)

## Test plan

Add round-trip cases to `test/round-trips.test.ts`:

1. **Preserve pre-existing `include`** on `pds l; pds g`:
   - Start fixture has `optimizeDeps: { include: ['foo'] }` (no `exclude`).
   - Run `pds l <pkg>` → expect `optimizeDeps: { include: ['foo'], exclude: ['<pkg>'] }`.
   - Run `pds g <pkg>` → expect `optimizeDeps: { include: ['foo'] }` (byte-identical to start).

2. **Preserve pre-existing `include` + unrelated `exclude`**:
   - Start: `optimizeDeps: { include: ['foo'], exclude: ['bar'] }`.
   - `pds l <pkg>; pds g <pkg>` → restores to start.

3. **Empty-block cleanup still works** (no regression): start with no `optimizeDeps`, `pds l; pds g` restores to no-block.

## Downstream

Once fixed, file a follow-up note in `hccs/path/www` to restore `optimizeDeps.include: ['plotly.js/basic']` (it was lost across recent `pds l/g` cycles and the site works without it, but the dev-server cold-start is measurably slower on the first dynamic import).

## Resolution

Implemented in `src/vite-config.ts`, replacing the regex editing in `updateViteConfig` (`src/switch.ts`, now a thin wrapper).

**Approach: parse to locate, splice to edit.** `@babel/parser` (TS plugin) finds the config object and the exact offsets of `optimizeDeps`, its `exclude` array, and the matching element; edits are text splices at those offsets. Nothing is re-printed, which is what sank the earlier `magicast` attempt (`957fa0f` → reverted in `e6e733b`: recast inserted blank lines and dropped the trailing newline). So regex fragility is gone without giving up byte-identical round-trips.

Behavior:
- **Add**: append to an existing `exclude` array; else add `exclude: [...]` as the last key of an existing `optimizeDeps` (siblings untouched); else append an `optimizeDeps` block to the config. No-op if already present (either quote style).
- **Remove**: remove only the element. If that empties `exclude`, remove the key; if that empties `optimizeDeps`, remove the block. An array left holding only comments is kept.
- Insert/remove are exact inverses for every list shape (single-/multi-line, with/without trailing comma, comments inside), so round-trips are byte-identical — including across multiple deps removed in either order.
- In multi-line lists, new entries go on their own line just before the closing bracket (so they land under a trailing `// pds` marker comment); removing an entry that sits on its own line also removes its trailing same-line comment.
- Config shapes: `defineConfig({...})`, arrow/function forms (`(...) => ({...})`, block body `return {...}`), bare object (`satisfies`/`as` unwrapped), or an identifier bound to one of those. Only the root config's direct `optimizeDeps` is touched (not `ssr.optimizeDeps`, not vitest's `test.exclude`, not imports/aliases).
- New entries follow the file's quote style (from its first `import ... from`).
- Files: `vite.config.{ts,mts,js,mjs}` (previously `.ts` only).
- If the config can't be edited safely (parse error, `exclude: someVar`, shorthand `optimizeDeps`, …), pds warns and leaves the file untouched rather than guessing.
- Blocks written by the old regex code (e.g. its mis-indented `exclude`) are cleaned up correctly.

The two symmetric concerns noted above (appending into an existing block / existing array on `pds l`) were also broken in the old code for some shapes (nested objects in `optimizeDeps` made its `[^}]*` match end early; a trailing-comma array produced `['bar',, 'x']`; the `exclude` replace targeted the *first* `exclude:` in the file, e.g. vitest's `test.exclude`). All covered now.

Tests:
- `test/vite-config.test.ts`: round-trip matrix (exact post-add text + byte-identical removal) over the shapes above, plus no-op, subpath, unsupported/parse-error, non-last/double-quoted removal, two-dep interleaving, and legacy-block cases.
- `test/round-trips.test.ts`: the spec's CLI-level `pds l` → `pds gh` cases. TFFP: the two `include`-only cases fail on the pre-fix code; the `include` + unrelated `exclude` case passed before too (array never emptied) and stays as a guard.
- One-off corpus check over all 65 local `vite.config.*` files under `~/c`: add → remove byte-identical, output parses, re-add is a no-op, and remove → re-add of every existing entry parses. 82 checks, 0 failures.

Downstream: filed `hccs/path/specs/restore-plotly-optimizedeps-include.md`.

## Follow-up: user-owned excludes (`keepViteExclude`)

pds can't tell an entry it added (for local HMR) from one the user wants permanently, and switching away from local used to remove both. Real case: `apvd` manages `@apvd/wasm` via pds *and* needs it excluded always (esbuild pre-bundling breaks WASM imports).

Resolved with a durable per-dep marker in `.pds.json` (not per-switch bookkeeping, which would churn the committed config and misjudge projects already in local mode):
- `keepViteExclude: true` — the entry is the user's; `cleanupDepReferences` leaves it. Set automatically when `pds l` finds the dep already in `exclude` while it wasn't local (package.json spec, or workspace membership for transitive deps), with a one-line notice; or via `pds set <dep> -k` when the dep is already local (not detectable).
- `keepViteExclude: false` (`pds set -K`) — pds owns it, and the auto-detection is skipped (otherwise the entry left behind while non-local would be re-detected as the user's on the next `pds l`).
- Unset — pds owns it; auto-detection applies.

A survey of local projects found no pds-managed dep sitting in `exclude` while non-local, so the auto-detection wouldn't mis-mark a stale entry anywhere today; apvd's `@apvd/wasm` (currently local) needs `pds set wasm -k`.
