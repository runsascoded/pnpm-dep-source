# Accept multiple package args in `pds init` / `pds g` / `pds gh` / `pds gl` / `pds l` / `pds n`

## Motivation

Forks like [Open-Athena/slidev] ship multiple sibling packages on a single
`dist` branch (in our case: `@slidev/cli`, `@slidev/client`, `@slidev/parser`),
and downstream consumers typically need *all* of them switched together
(otherwise the active `@slidev/cli` fork pulls upstream `@slidev/client` via
its transitive deps, silently losing the fork features).

Today users have to run `pds init` once per sub-package, then `pds g` once
per package to advance them all to a new dist SHA. With three packages
that's six invocations to perform a single conceptually-atomic operation.

Goal: one call that handles all of them.

[Open-Athena/slidev]: https://github.com/Open-Athena/slidev

## Proposal

Accept *multiple* positional dep args wherever `pds` currently accepts a
single optional one — i.e. all the source-switch verbs (`local|l`,
`github|gh`, `gitlab|gl`, `auto|g`, `npm|n`) and `init`. When several deps
are passed, run the existing single-dep logic for each in turn, sharing
the same flags (`-r`, `-R`, `-n`, `-D`, `-s`, etc.).

### `init` with multiple targets

```bash
# All three URLs go through the same auto-detection / resolution path.
pds init \
  https://github.com/Open-Athena/slidev/tree/main/packages/slidev \
  https://github.com/Open-Athena/slidev/tree/main/packages/client \
  https://github.com/Open-Athena/slidev/tree/main/packages/parser

# Same for local paths (a monorepo with sub-packages):
pds init ../../slidev/packages/slidev ../../slidev/packages/client ../../slidev/packages/parser
```

After each one, the existing per-dep behavior runs (add to package.json,
write `.pds.json`, etc.). The final `pnpm install` should fire **once** at
the end, not per-package, to avoid re-resolving the lockfile N times.

### Switch verbs with multiple targets

```bash
pds g slidev client parser              # advance all 3 to current dist HEAD
pds gh slidev client parser -R dist     # pin all 3 to the branch name
pds gh slidev client parser -r v1.2.3   # resolve a shared ref → SHA per dep
pds l slidev client parser              # all to workspace:*
pds n slidev client parser              # back to npm published versions
```

Same rule on the install fire — coalesce to one trailing `pnpm install`.

## Behavior notes / edge cases

- **Ambiguity**: today, the single-arg form treats a missing arg as "use the
  only configured dep, else error". Multi-arg adds no ambiguity — `pds g` with
  zero args still falls back to "all configured deps" (a natural extension)
  *or* "the only configured dep" (current behavior). I'd lean toward
  zero-args = all configured, as an ergonomic improvement, but it's a
  judgment call. **Recommend keeping current zero-arg semantics unchanged**
  to avoid surprising one-dep users.

- **Substring matches**: deps already match by unique substring (per the
  `pds` README). Multi-arg should keep that behavior per arg.

- **Per-dep failures**: if `pds g slidev client parser` fails on one dep
  (e.g. network), should the others continue? I'd suggest **stop-on-first-
  failure** by default + a `--keep-going` / `-k` flag for "best-effort"
  semantics. Both are reasonable; stop-on-first matches typical CLI
  conventions.

- **Flag scope**: a single `-r v1.2.3` resolves to the same SHA for all
  deps (assuming they're sibling packages in one repo, which is the
  motivating case). If deps come from different repos and the ref doesn't
  exist in some, behavior is "error per dep" with the stop-on-first-
  failure rule above. Could also support per-dep refs (e.g. `-r dep1=sha
  dep2=sha`) but that's clearly out of scope for v1 of this change.

- **`.pds.json` ordering**: when init'ing many deps, write them to
  `.pds.json` in input order. Predictable for diffs.

- **Dry-run (`-n`)**: prints what each dep would resolve to, exit code 0.
  No `pnpm install` fired even at the end.

## Out of scope

- `pds rm` / removal multi-arg (already useful, but separate change).
- Mixing source kinds in one call (e.g. `pds slidev=gh client=l parser=n`).
  Today each source has its own subcommand; one source per call is fine.
- Adding `--all` flag. Trivially equivalent to `pds g $(pds list)` and
  doesn't justify the new flag-surface.

## Where to change

The argument parsers in `src/cli.ts` (or wherever the click-equivalent /
yargs / commander definitions live) — currently `argument(dep)` becomes
`argument(dep, multiple=true)` or equivalent. Then `cmd_handler(dep, ...)`
becomes a small loop over `deps`. The trailing-`pnpm install` coalesce is
the only non-mechanical part: make sure each per-dep step *doesn't*
install on its own, then run install once at the end (unless `-n`).

## Implementation notes

- Added a small `runMultiple` helper in `src/cli.ts` to iterate deps with
  either stop-on-first-failure (default) or `-k`/`--keep-going` semantics.
  With `-k`, per-dep errors are logged but iteration continues, and the
  process exits non-zero at the end if any failed.
- All five switch verbs (`local`/`l`, `github`/`gh`, `gitlab`/`gl`,
  `git`/`g`, `npm`/`n`) and `init` accept `[deps...]` (or
  `[paths-or-urls...]` for `init`).
- Project-mode `pnpm install` fires once at the end — the per-dep work is
  done first, install only after the loop, and only when at least one dep
  was mutated.
- Zero-arg behavior on switch verbs is unchanged (errors when multiple deps
  are configured and none specified).
- `npm` keeps its 1- and 2-arg disambiguation (`npm <ver>` and
  `npm <dep> <ver>`); 3+ args are always treated as multi-dep queries with
  no explicit version.
- Each switch verb (and `init`) gained a `-k`/`--keep-going` flag.
- Tests live under `test/round-trips.test.ts` in a new `multi-arg` describe
  block covering: multi-arg `local`/`gh`/`npm`/`init`, stop-on-first-failure
  default, and `-k` continues past failure.
