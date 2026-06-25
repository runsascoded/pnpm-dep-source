# `pkg.pr.new` source mode (`pds cr`)

Add a first-class **`pkg.pr.new`** source, a sibling to `local` / `github` / `gitlab` /
`npm`, so a dependency can be pointed at a SHA-pinned [pkg.pr.new] continuous-release
build. Primary motivation: cleanly toggle a **multi-package monorepo fork** between a
local checkout and a remote built version, e.g.

```bash
pds l  @slidev/cli @slidev/client @slidev/parser   # local fork checkout
pds cr @slidev/cli @slidev/client @slidev/parser   # remote pkg.pr.new build (SHA-pinned)
```

[pkg.pr.new]: https://pkg.pr.new

## Why this, not `gh`

`pds gh` points at `github.com/<repo>#<ref>&path:/<subdir>` — raw git source. For a
monorepo like slidev that doesn't work: the source packages have unresolvable
`workspace:*` / `catalog:` deps and no build output, so you'd need a built,
dep-resolved **dist branch** per package (the `npm-dist` approach).

`Open-Athena/slidev` actually built that (npm-dist `@pkgs` multi-package `build-dist.yml`),
got it working, then **deleted it** in favor of pkg.pr.new (commit `d5d8c13a`):

> `pkg.pr.new` auto-publishes SHA-pinned previews on every push to main and works with
> any package manager, no `pnpm.overrides` gymnastics. The `dist` branch + `build-dist.yml`
> workflow are redundant.

pkg.pr.new (via a `cr.yml` CI workflow) publishes every package on each push/PR and, for a
monorepo, **rewrites the inter-package `workspace:*` specs to the sibling packages'
pkg.pr.new URLs** — so installing the set wires them together with no `overrides`. That is
exactly the gap `pds gh` can't fill, and it's the modern continuous-release pattern in
general. So this should be its own source mode, not a tweak to `gh`.

## URL format

```
https://pkg.pr.new/<owner>/<repo>/<npmName>@<sha>
```

Derivable entirely from existing `DepConfig` fields + a resolved SHA:

- `<owner>/<repo>` = `DepConfig.github` (e.g. `Open-Athena/slidev`)
- `<npmName>`      = `DepConfig.npm` (e.g. `@slidev/cli`, scope included)
- `<sha>`         = resolved commit SHA (see below)

`DepConfig.subdir` is **not** used (unlike `gh`): pkg.pr.new addresses by package name, not
repo path. No new `DepConfig` field is required — pkg.pr.new reuses `github` + `npm`.

This is a raw `https://…` tarball-style URL that pnpm installs directly — mechanically the
same shape pds already emits for **GitLab** (`switchToGitLab` builds a raw tarball URL,
updates the dep, drops it from the workspace + vite `optimizeDeps`). `switchToPkgPrNew`
mirrors that almost exactly.

## SHA resolution

Reuse `resolveGitHubRefAsync(github, ref)` (pkg.pr.new repos are GitHub-hosted):

- Default `ref`: the repo's default branch (`main`). (Contrast `gh`, which defaults to the
  `dist` branch — pkg.pr.new has no dist branch; builds key off main/PR commits.)
- `-r <ref>` resolves a ref → SHA; `-R <ref>` uses a ref as-is (branch/tag name, not SHA).
- Use the full SHA returned by the GitHub API (pkg.pr.new accepts full or short; full is
  unambiguous).

**Build-existence check (recommended).** A pkg.pr.new URL only resolves once CI has built
that SHA. After resolving, optionally `HEAD` the URL and **warn** (don't hard-fail) if it
404s — "no published build for `<sha>` yet; CI may still be running." Gate behind the
default; `-n` dry-run prints the URL without checking.

## CLI surface

New command, mirroring `gh`/`gl`:

```
pds cr [deps...]            # switch deps to pkg.pr.new (default ref: main HEAD → SHA)
pds cr [deps...] -r <ref>   # resolve a ref to SHA
pds cr [deps...] -R <ref>   # use ref as-is
pds cr [deps...] -n         # dry-run: print the URL(s), no install/HEAD-check
pds cr [deps...] -I         # skip pnpm install
pds cr [deps...] -k         # keep going past per-dep failures
```

**Naming — decision needed.** Options: `cr` (short; matches the `cr.yml` "continuous
releases" convention) with a `pkg-pr-new` long alias; or `prnew`. Recommendation: primary
`cr`, alias `pkg-pr-new`.

Also extend the existing source plumbing:

- `init -s <source>`: accept `cr` / `pkg-pr-new` (so `pds init <path> -s cr` works).
- `activateSource` unions in `cli.ts` (the `'local' | 'github' | 'gitlab' | 'npm'` type):
  add `'cr'`, and the dispatch that calls `switchToGitHub` / `switchToGitLab`.
- Per-dep sources already compose, so a mixed set works out of the box, e.g. for slidev:
  `pds cr @slidev/cli @slidev/client @slidev/parser` + leave `@slidev/types` on `npm`
  (it's unchanged upstream in that fork).

## Files to touch

- **`src/switch.ts`** — add `switchToPkgPrNew(projectRoot, depName, depConfig, resolvedSha, …)`
  modeled on `switchToGitLab`: build the URL, `updatePackageJsonDep`, `removeFromWorkspace`,
  `updateViteConfig(..., false)`. Add a `makePkgPrNewSpecifier(github, npm, sha)` helper next
  to `makeGitHubSpecifier`.
- **`src/cli.ts`** — register the `cr` command; extend `activateSource` unions + `init -s`
  parsing + the switch dispatch; add config validation (`github` + `npm` required).
- **`src/remote.ts`** — optional `pkgPrNewBuildExists(url): Promise<boolean>` (HEAD check).
  SHA resolution reuses `resolveGitHubRefAsync`.
- **`src/display.ts`** — recognize `https://pkg.pr.new/…` deps as `sourceType: 'cr'`
  (status/`ls`); parse the trailing `@<sha>` for display; update `parseGlobalPkgSource` for
  global installs.
- **`src/types.ts`** — `DepDisplayInfo.sourceType` add `'cr'`; `RemoteVersions` may gain a
  `cr`/`crSha` field if `versions`/status should surface the latest pkg.pr.new SHA.
- **`README.md`** — document the mode + the slidev example.

## Status / round-trip detection

`pds status` / `ls` must recognize a dep currently set to a pkg.pr.new URL and report it as
`cr` (with the pinned SHA), the same way github (`github:…#sha`) and gitlab (tarball URL)
specifiers are detected today. Parse `^https://pkg\.pr\.new/(.+?)/(@?[^@/]+(?:/[^@/]+)?)@(\w+)$`
→ `{ repo, npmName, sha }`.

## Tests

- `makePkgPrNewSpecifier` / URL construction (incl. scoped names).
- `switchToPkgPrNew` round-trip: package.json dep set correctly, removed from
  `pnpm-workspace.yaml` + vite `optimizeDeps` (reuse the existing switch test fixtures).
- Status detection: a pkg.pr.new dep is reported as `cr` with the right SHA.
- CLI parsing for `cr` + `init -s cr`.
- (If HEAD-check added) mock the fetch for present/absent builds.

## Resolved decisions

1. **Command name**: `cr` (primary) + `pkg-pr-new` (alias). ✅
2. **Default ref**: the repo's default-branch HEAD, resolved via the GitHub API
   `repos/<repo>/commits/HEAD` (robust to a non-`main` default branch) — not hardcoded
   `main`. `-r <ref>` resolves a ref → SHA; `-R <ref>` uses it as-is. ✅
3. **Build-existence HEAD check**: warn-only, default on. After switching, each URL is
   HEAD'd concurrently; a 404 prints a warning but does not fail. Skipped on `-n` dry-run
   (nothing was switched). ✅
4. **pkg.pr.new host/owner**: always derived from `DepConfig.github` (`<owner>/<repo>`) +
   `DepConfig.npm` (`<npmName>`). No new `DepConfig` field. ✅
5. **`pds g`**: unchanged — stays github-or-gitlab; `cr` is explicit only. ✅

## Implementation notes (done)

- `switchToPkgPrNew` reuses `cleanupDepReferences` (drop from `pnpm-workspace.yaml` + vite
  `optimizeDeps.exclude`) — the same cleanup `gh`/`gl`/`npm` switches perform.
- `extractSourceSha` matches the **trailing** `@<hex>` (the npm scope also contains `@`).
- Display: a `pkg.pr.new` line is surfaced only when `cr` is the active source (it has no
  dedicated config field), with `GitHub`/`NPM` shown as inactive alternatives.
- Tests: `makePkgPrNewSpecifier` URL construction (scoped + unscoped), `getSourceType` /
  `extractSourceSha` / `getActiveParts` / `displayDep` for `cr` (`test/display.test.ts`);
  `switchToPkgPrNew` round-trip file mutations (`test/switch.test.ts`); CLI dry-run, status
  detection, `ls -s cr`, `init -s cr`, and the missing-npm error (`test/round-trips.test.ts`).
  CLI file-mutation paths avoid the network by going through `init -s cr -R` (no HEAD check)
  and unit-testing `switchToPkgPrNew` directly.

### `-a`/`--all` multi-match (follow-up)

Switching a whole monorepo fork was still verbose (`pds cr @slidev/cli @slidev/client
@slidev/parser` — listing each sub-package), because a query had to resolve to exactly one
dep (a substring hitting several errors as ambiguous). Added a cross-cutting `-a`/`--all`
flag to every switch verb (`l`/`gh`/`gl`/`g`/`cr`/`n`): each query becomes a
case-insensitive **regex** matching ALL deps (union, deduped, config order); a bare
invocation selects every configured dep. So `pds cr slidev -a` (or `pds cr -a`) now flips
the whole set; `pds cr '@slidev/(cli|parser)$' -a` scopes it (anchored, since matching is
unanchored and `cli` otherwise also matches `@slidev/client`). Implemented as
`findAllMatchingDeps` (`config.ts`) + `resolveDepItems` (`cli.ts`); the switch commands now
resolve their dep list up front rather than per-query inside `runMultiple`. Covered by
`test/config.test.ts` + a `multi-match` block in `test/round-trips.test.ts`.

## Downstream (separate, in the consuming repo)

Once `pds cr` lands, `safe26` (and other `Open-Athena/slidev` decks) can `pds init` the
slidev packages (already done on a branch) and use `pds l ↔ pds cr` — letting the deck's
CI/deploy `pnpm install` the pkg.pr.new URLs instead of cloning + building the fork.
