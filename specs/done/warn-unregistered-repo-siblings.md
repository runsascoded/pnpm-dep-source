# Warn when a registered dep has unregistered siblings from the same repo

Source: ctbk session, 2026-08-29, after a `pds l` that appeared to succeed but silently validated the wrong code.

## What happened

`gbfs/cascade`'s `package.json` depends on `pyrmts`, `pyrmts-cfw`, and `pyrmts-geo` — three packages published from one repo (`runsascoded/pyrmts`, subdirs under `/js/packages/`). Its `.pds.json` registered only the first two, because the config was built by `pds init`-ing individual package paths rather than the monorepo root.

`pds l pyrmts pyrmts-cfw pyrmts-geo` then failed correctly and loudly:

```
Error: No dependency matching "pyrmts-geo" found in config
$ echo $?
1
```

Nothing was linked — the operation is atomic, which is right. The consumer then ran its test suite against the *pinned* dist and read the green as validating local changes it had never loaded. (The proximate cause was on the consumer's side: `pds l … | tail -3 && npx tsc` handed `&&` the pipe's exit status. pds is not responsible for that.)

**Not a gap:** `pds l -a` already exists and is the right habit for a fleet — it links every configured dep with no names to typo, and it works. This spec does not ask for that.

## The residual gap

The config was *incomplete in a detectable way*: `package.json` depended on `pyrmts-geo`, and an already-registered dep (`pyrmts`) declared `github: runsascoded/pyrmts`. pds had both halves and said nothing. `-a` doesn't help here — it faithfully links the two that are registered, so the fleet is still half-swapped, and with `pyrmts-cfw` carrying `pyrmts@workspace:*` a partial swap fails at install time with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`, or (worse) resolves to a mix.

## Proposal

On `ls`, and before any `local`/`github`/`gitlab`/`git`/`cr` switch, cross-reference `package.json` dependencies against registered deps grouped by `github`/`gitlab` repo. For each repo with ≥1 registered dep, any *unregistered* `package.json` dependency whose name matches a sibling package in that repo gets a warning:

```
⚠️  pyrmts-geo is a dependency but isn't managed by pds, and comes from
    runsascoded/pyrmts (same repo as: pyrmts, pyrmts-cfw).
    Register it:  pds init <path-to>/pyrmts-geo
    Or the fleet: pds init <monorepo-root>
```

Warn, don't error — a consumer may legitimately want one package of a repo pinned while others float.

Sibling identification without a network call: if the registered deps' `localPath`s share a parent (`…/js/packages/{pyrmts,pyrmts-cfw}`), read that parent's entries and match `package.json` names. Falling back to "unregistered dep whose name shares the registered dep's package-name prefix" would catch this case too, but is heuristic; the shared-parent check is exact when local paths are configured.

## Why it's worth doing

`init`'s monorepo-root expansion already encodes "these packages travel together" — this makes the same knowledge available *after* a config was built the other way, which is the state real configs drift into. The failure it prevents is a silent one: a half-swapped fleet still installs, still runs, and still reports green.

## Acceptance

- A project with `{pyrmts, pyrmts-cfw}` registered and `pyrmts-geo` an unregistered dependency warns on `pds ls` and on `pds l`, naming the repo and both registered siblings.
- Same project with all three registered: silent.
- A dep from an unrelated repo, unregistered: silent (no shared parent, no repo match).
- Warning goes to stderr; exit code unchanged; `--no-install`/dry-run paths unaffected.

## Resolution

Implemented in `src/siblings.ts`: `findUnregisteredSiblings` (pure), `formatSiblingWarning`, and `warnUnregisteredSiblings` (called once from each of `ls`, `status`, `local`, `github`, `gitlab`, `git`, `cr` in `src/cli.ts`).

Detection, per registered dep with an existing `localPath` (no network):
- Its repo = the nearest ancestor with a `.git` entry. Deps whose repo is the **consumer's own** are skipped (in-repo workspace packages aren't an external fleet; e.g. `apvd`'s `@apvd/*`).
- Candidates = packages of the nearest workspace enclosing the dep (walking up to the repo root; reuses `listWorkspacePackages` from `fleet.ts`, i.e. the same expansion `init <monorepo-root>` uses), plus package dirs sharing the dep's parent dir. The shared-parent scan is skipped when the dep *is* its repo root, so a `$js/<lib>` next to other single-package repos never flags its neighbors.
- A candidate is flagged if it's in the consumer's `dependencies`/`devDependencies` and neither a registered dep name nor a registered `npm` name.
- Repo label: the registered deps' `github` (else `gitlab`) slug, else the repo's cwd-relative path.

Warning (via `log.warn`, so stderr and `PDS_LOG_LEVEL`-controlled; once per process; exit code unchanged; any detection error demoted to a debug log):

```
[pds:warn] pyrmts-geo is a dependency but isn't managed by pds, and comes from runsascoded/pyrmts (same repo as: pyrmts, pyrmts-cfw).
  Register it:  pds init ../pyrmts/js/packages/pyrmts-geo
  Or the fleet: pds init ../pyrmts
```

The fleet line appears only when an enclosing workspace was found. Paths are cwd-relative (where `pds init` resolves them).

Deviations:
- `[pds:warn]` prefix instead of the spec's `⚠️`, matching pds's other warnings.
- No name-prefix heuristic (the workspace + shared-parent checks are exact and cover the pyrmts layout).
- `npm` switches don't warn (per the spec's list of switch verbs).

Tests: `test/siblings.test.ts`. Unit: acceptance cases (flag with repo + both registered siblings; silent when all registered; silent for unrelated/undepended siblings), `devDependencies`, repo-root dep not flagging neighbor repos, shared-parent without workspace, consumer's own repo ignored, missing `localPath`, exact warning text. CLI: `ls` and multi-dep `local -I` emit exactly one warning on stderr with exit 0; silent when all registered. TFFP: the two CLI warning tests fail with the hook disabled.

Verified against all 37 `.pds.json` projects under `~/c`: no warnings (all fleets fully registered; each check under 50 ms). Re-running `gbfs/cascade` with `pyrmts-geo` dropped from its config reproduces the warning from the real layout (no fleet line: `~/c/pyrmts` has no workspace file, so it's found via the shared parent).
