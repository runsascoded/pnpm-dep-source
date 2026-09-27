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
