# Override strategy (`pnpm.overrides`-managed deps)

## Problem

The default `pds` switch strategy rewrites each dep's **`package.json` dependency
spec** (`workspace:*`, a `github:`/tarball URL, a pkg.pr.new URL, or an npm range).
That works for a normal single-package dep, but it cannot force *transitive*
siblings of a **monorepo fork** to follow.

Concrete case (`hccs/safe26` consuming a fork of slidev): the deck depends only on
`@slidev/cli`, but `@slidev/cli` pulls `@slidev/client` / `@slidev/parser` /
`@slidev/types` transitively. Switching `@slidev/cli` to a local checkout (or a
pkg.pr.new build) still left the three siblings resolving from **upstream npm**
unless every consumer in the graph also pointed at the fork. Empirically, only a
graph-wide `pnpm.overrides` block forced all four `@slidev/*` to a single forked
version with no upstream copy.

## Design

Opt a dep into override management with `override: true` in `.pds.json` (set via
`pds init -o` / `pds set -o`, cleared with `pds set -O`). When set, every switch
verb rewrites a single **`pnpm.overrides[<name>]`** entry at the **workspace root**
(the dir holding `pnpm-workspace.yaml`, or the single-package project root — the
only place `pnpm` honors overrides and resolves `link:` relative to), and leaves
the `package.json` dep spec, `pnpm-workspace.yaml`, and `vite.config.ts` as a
static baseline.

| verb | override value |
| --- | --- |
| `l`  | `link:<relative-path>` (symlink; the checkout's own `node_modules` resolves siblings) |
| `cr` | `https://pkg.pr.new/<owner>/<repo>/<npmName>@<sha>` |
| `gh` | `https://github.com/<owner>/<repo>#<sha>` |
| `gl` | GitLab archive tarball URL |
| `n`  | `^<version>` (pins the whole graph to a published version) |

A `pnpm.overrides` entry forces resolution for the entire dependency graph, so it
delivers the forked packages everywhere — including the transitive siblings. The
toggle is therefore just rewriting N override values; no `package.json` /
workspace / vite churn.

## Implementation

- **`types.ts`** — `DepConfig.override?: boolean`.
- **`pkg.ts`** — `setPnpmOverride` / `getPnpmOverride`; `removePnpmOverride` now
  also deletes the `pnpm` block when it empties; `savePackageJson` sorts
  `pnpm.overrides` keys.
- **`switch.ts`** — `overrideRoot()`, `applyOverride()`, `makeLinkSpecifier()`;
  each `switchTo*` branches on `depConfig.override` before its default path;
  `switchToLocal` now takes the full `DepConfig`; `cleanupDepReferences` strips the
  override for override deps (so `deinit`/`rm` clean up).
- **`cli.ts`** — `-o/--override` on `init`; `-o/--override` + `-O/--no-override`
  on `set`; `loadOverrides()` (reads the workspace-root overrides map); `status`
  and `ls`/`displayDep` surface the override-driven source with an `[override]`
  tag; `check` (git hook) treats a `link:`/`file:` override as "local".
- **`display.ts`** — `getSourceType` maps `link:`/`file:` → `local`; the project
  dep-info builders read the active source from the overrides map for override
  deps and suppress the committed-source "was/now" transition (the baseline is
  intentionally static).

## Tests

- `test/switch.test.ts` — `override strategy` describe: link/cr/gh/npm override
  writes, l→cr→npm round-trip touches only the single override entry, baseline
  untouched, transitive (not-in-`package.json`) dep, `cleanupDepReferences`
  removes the entry + empty `pnpm` block, sibling overrides preserved.
- `test/round-trips.test.ts` — `override mode` describe: `set -o`/`-O`,
  `local` writes `link:` + leaves baseline, gh→l→gh single-entry rewrite,
  `status` `[override]` tag, `deinit` cleanup.

## Exemplar

`hccs/safe26` is configured with all four `@slidev/*` deps `override: true`. The
fleet toggles with:

```bash
pds l  slidev -a    # link: overrides → local clone (HMR; serves uncommitted edits)
pds cr slidev -a    # pkg.pr.new overrides → SHA-pinned fork build
```

Verified end-to-end: in `l` mode `@slidev/cli` links to the clone and `@slidev/client`
resolves (via the linked cli's tree) to `~/c/slidev/packages/client`; in `cr` mode all
four resolve to the fork build (`@slidev/cli@52.16.0`) with no upstream copy.

### `l` ↔ `cr` round-trip is a no-op

Goal: toggling `pds l` ↔ `pds cr` must not accrue drift. Verified in `safe26`:

- **Config level** (`pds … -a -I`, no install): `l → cr → l` restores `package.json`
  byte-for-byte, and `cr → l → cr` likewise; `pnpm-workspace.yaml` and
  `vite.config.ts` are never touched by the toggle (override mode only rewrites
  `pnpm.overrides`). Stable because override keys are sorted on save and the `cr`
  SHA is deterministic from the GitHub default-branch HEAD.
- **Install level** (real `rm -rf node_modules && pnpm install` each step): the
  `pnpm-lock.yaml` after `l → cr → l` is byte-identical to the starting `l` lock.

### Gotcha: override-only consumers must declare their own config deps

Dropping a monorepo from `pnpm-workspace.yaml` `packages:` (the override approach)
also drops the **hoisting** of that monorepo's transitive deps. `safe26`'s
`vite.config.ts` does `import { defineConfig } from 'vite'`, which previously
resolved only because workspace-membered slidev hoisted `vite` into safe26's flat
`node_modules` (`shamefullyHoist`). Under override-only management that hoist is
gone, so the consumer must declare any package its **own** config/code imports as a
direct dep (safe26 now lists `vite` in `devDependencies`). This is strictly more
correct (explicit deps); deps consumed only *through* the linked package still
resolve via that package's own tree.

### `noDist`: forks with no dist branch omit the gh/gl row

The slidev fork ships built packages via **pkg.pr.new** (`cr`), not an npm-dist
`dist` branch. So `@slidev/*`'s `github` field exists only to derive pkg.pr.new
URLs — the repo isn't installable via `gh`/`gl`/`git` (dist-tarball) mode, and the
`GitHub:` row + `…@dist` probe in `ls`/`status` were dead weight (and emitted
`404`/`422` warnings).

`init` now probes the configured repo's dist branch and records the dep's *style*:
when the repo resolves but the branch is absent (gh: "No commit found for the
ref …"), it writes `"noDist": true` (dropping `distBranch`). `isMissingRef`
distinguishes this from a bare 404 (typo'd / nonexistent repo), which is **not**
marked. A `noDist` dep:

- skips the dist ref/`package.json` probe entirely (no API call, no warning), and
- omits its `GitHub:`/`GitLab:` row from `ls`/`status` in **all** modes (the
  config marker is honored without a probe, so non-verbose is consistent too).

A live verbose probe still omits the row for un-migrated deps (`*DistMissing`
flags), and `withRetry` downgrades not-found (404/422) to `debug` so the dist
warnings are gone regardless. `safe26`'s four `@slidev/*` deps carry `noDist:
true`. Re-`init` refreshes the marker if a repo later gains a dist branch.

## Populating `override` with less friction (implemented)

Three layered ways to set up an override-managed fleet, so the consumer needn't
know a fork's sub-package layout — `pds init <monorepo-root>` expands to the fleet:

1. **Hint file** (`src/fleet.ts` `readPdsHint`) — `pds.json` at the repo root, or a
   `"pds"` key in its `package.json`: `{ strategy?: 'override'|'default', fleet?:
   string[] }`. Authoritative; declares exactly which packages are consumable.
   The slidev fork ships `pds.json` listing the four runtime `@slidev/*` packages
   (excluding `create-*` scaffolders and `@slidev/docs`).
2. **Auto-detect** (`src/fleet.ts` `detectFleet` / `listWorkspacePackages`) — no
   hint: enumerate the workspace (`pnpm-workspace.yaml` `packages:` or
   `package.json` `workspaces`, with a minimal `*`-glob expander) and take the
   publishable (non-`private`) packages; >1 member ⇒ `override` strategy. Repo from
   the root git remote; each member's `npm`/`subdir` from its `package.json`.
3. **Explicit `-o`** — `pds init -o` / `pds set -o` for a single dep.

`cli.ts` wires this in: `init` calls `detectFleet(resolve(path))` for each local
path arg; a non-null result routes to `registerFleet` (config + activation via the
existing `switchTo*` helpers), else the normal single-dep `initOne`. Tests:
`test/fleet.test.ts` (detection: enumerate, auto-detect excludes private, hint
narrows/includes-private, `workspaces` field, `package.json#pds`), and a
`round-trips.test.ts` `init fleet expansion` case (end-to-end `init <root>` →
override deps + `link:` overrides).
