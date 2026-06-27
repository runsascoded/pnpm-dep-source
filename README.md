# pnpm-dep-source

[![npm version](https://img.shields.io/npm/v/pnpm-dep-source)](https://www.npmjs.com/package/pnpm-dep-source)

CLI to switch pnpm dependencies between local, GitHub / GitLab, [pkg.pr.new], and NPM sources.

[pkg.pr.new]: https://pkg.pr.new

## Installation

```bash
npm install -g pnpm-dep-source
# or
pnpm add -g pnpm-dep-source
```

## Usage

### Initialize a dependency

```bash
# From local path - auto-detects GitHub/GitLab from package.json or git remote
pds init ../../path/to/local/pkg

# From GitHub/GitLab URL
pds init https://github.com/user/repo
pds init https://gitlab.com/user/repo

# Override or specify repo explicitly
pds init ../../path/to/local/pkg -H github-user/repo
pds init ../../path/to/local/pkg -L gitlab-user/repo

# Init from local path but activate GitHub/GitLab source
pds init ../../path/to/local/pkg -s gh   # activate GitHub after init
pds init ../../path/to/local/pkg -s gl   # activate GitLab after init
pds init ../../path/to/local/pkg -s g    # auto-detect (errors if ambiguous)
pds init ../../path/to/local/pkg -s cr   # activate pkg.pr.new after init

# Multiple paths/URLs in one call (e.g. monorepo sibling packages):
pds init ../../slidev/packages/{slidev,client,parser}

# Global CLI tools (uses ~/.config/pnpm-dep-source/config.json)
pds -g init /path/to/local/cli
```

`init` **adds the dependency to `package.json`** if not present, then **auto-activates**:
- Local path → switches to `workspace:*` mode (unless `-s` overrides)
- GitHub URL → switches to `github:user/repo#sha`
- GitLab URL → switches to GitLab tarball URL

Use `-D` to add as a devDependency, `-I` to skip adding/activation, or `-s <source>` to activate a specific source (e.g. init from a local path but immediately point at the GitHub dist branch).

### Switch to local development

```bash
pds local [deps...]    # or pds l [deps...]
```

Note: deps are optional if only one dependency is configured. Pass multiple deps to switch them all in one call (e.g. monorepo sibling packages):

```bash
pds l slidev client parser    # all three to workspace:*
```

This will (per dep):
- Set `package.json` dependency to `workspace:*`
- Create/update `pnpm-workspace.yaml` with the local path
- Add to `vite.config.ts` `optimizeDeps.exclude` (if vite config exists)

One `pnpm install` is run at the end (skip with `-I`).

### Switch to GitHub or GitLab (auto-detect)

```bash
pds g [deps...]                   # Auto-detects GitHub or GitLab (uses dist branch HEAD)
pds g [deps...] -r v1.0.0         # Resolves ref to SHA (shared across deps)
pds g [deps...] -R dist           # Uses ref as-is (pin to branch name)
pds g [deps...] -n                # Dry-run: show what would be installed
```

Errors if neither or both are configured; use `pds gh` or `pds gl` explicitly in that case.

### Switch to GitHub

```bash
pds github [deps...]              # Uses dist branch HEAD (resolved to SHA)
pds gh [deps...] -r v1.0.0        # Resolves ref to SHA
pds gh [deps...] -R dist          # Uses ref as-is (pin to branch name)
pds gh [deps...] -n               # Dry-run: show what would be installed
```

This will (per dep):
- Set `package.json` dependency to `github:user/repo#sha`
- Remove local path from `pnpm-workspace.yaml`
- Remove from `vite.config.ts` `optimizeDeps.exclude`

One `pnpm install` is run at the end (skip with `-I`).

### Switch to GitLab

```bash
pds gitlab [deps...]              # Uses dist branch HEAD (resolved to SHA)
pds gl [deps...] -r v1.0.0        # Resolves ref to SHA
pds gl [deps...] -R dist          # Uses ref as-is (pin to branch name)
pds gl [deps...] -n               # Dry-run: show what would be installed
```

This will (per dep):
- Set `package.json` dependency to GitLab tarball URL
- Remove local path from `pnpm-workspace.yaml`
- Remove from `vite.config.ts` `optimizeDeps.exclude`

One `pnpm install` is run at the end (skip with `-I`).

Note: GitLab uses tarball URLs (e.g. `https://gitlab.com/user/repo/-/archive/ref/repo-ref.tar.gz`) since pnpm doesn't support `gitlab:` prefix.

### Switch to pkg.pr.new (continuous release)

```bash
pds cr [deps...]                  # Default-branch HEAD, resolved to SHA
pds cr [deps...] -r v1.0.0        # Resolves ref to SHA
pds cr [deps...] -R main          # Uses ref as-is (pin to branch/tag name)
pds cr [deps...] -n               # Dry-run: print the URL(s), no install/HEAD-check
pds pkg-pr-new [deps...]          # Long alias
```

[pkg.pr.new] publishes a SHA-pinned preview of every package on each push/PR. For a
**monorepo fork** it rewrites the inter-package `workspace:*` specs to the sibling
packages' pkg.pr.new URLs, so installing the set wires them together with no
`pnpm.overrides` gymnastics — the gap `pds gh` can't fill for a monorepo whose source
packages have unresolvable `workspace:*` / `catalog:` deps and no build output.

This will (per dep):
- Set `package.json` dependency to `https://pkg.pr.new/<owner>/<repo>/<npmName>@<sha>`
- Remove local path from `pnpm-workspace.yaml`
- Remove from `vite.config.ts` `optimizeDeps.exclude`

The URL is derived from the dep's existing `github` (`<owner>/<repo>`) + `npm` (`<npmName>`,
scope included) config — no new config field. The SHA defaults to the GitHub
default-branch HEAD; use `-r`/`-R` to target another ref. After switching, `pds cr` HEADs
each URL and **warns** (does not fail) if the build isn't published yet (CI may still be
running); `-n` dry-run skips the check.

This makes it easy to toggle a monorepo fork between a local checkout and a remote build:

```bash
pds l  @slidev/cli @slidev/client @slidev/parser   # local fork checkout
pds cr @slidev/cli @slidev/client @slidev/parser   # remote pkg.pr.new build (SHA-pinned)
```

[pkg.pr.new]: https://pkg.pr.new

### Switch to NPM

```bash
pds npm [deps...]          # Latest version (per dep)
pds npm [dep] [version]    # Specific version (single dep only)
pds n 1.2.3                # With one dep configured, arg is treated as version
pds n [deps...] -n         # Dry-run: show what would be installed
```

Note: passing a shared `[version]` across multiple deps is not supported (versions differ per dep) — with 3+ args, all are treated as dep queries.

### Multi-dep behavior

All switch verbs (`l`/`gh`/`gl`/`g`/`cr`/`n`) and `init` accept multiple deps in one call:

- **One trailing `pnpm install`**: per-dep work runs first, then a single install fires at the end.
- **Stop on first failure (default)**: if one dep fails, later deps are not processed. Per-dep changes already applied are kept.
- **`-k`/`--keep-going`**: continue past per-dep failures, log each, and exit non-zero at the end if any failed.
- **Zero-arg fallback** is unchanged: `pds gh` with no dep query still requires exactly one dep configured (errors otherwise).

#### `-a`/`--all`: match many deps at once

By default each query must resolve to **exactly one** dep (a substring that hits several is rejected as ambiguous). `-a`/`--all` instead treats each query as a **case-insensitive regex** and switches **every** matching dep — ideal for a monorepo fork with many sibling sub-packages:

```bash
pds cr slidev -a                 # all deps matching /slidev/i → pkg.pr.new
pds cr -a                        # no query → ALL configured deps
pds l  '@slidev/' -a             # all @slidev/* → local
pds cr '@slidev/(cli|parser)$' -a   # regex: just cli + parser (anchored)
pds cr cli parser -a             # multiple patterns, union (deduped)
```

Matching is unanchored, so `cli` also matches `@slidev/client` (it contains `cli`); anchor with `$` (e.g. `cli$`) to scope it. A pattern that matches nothing errors.

**Transitive deps.** A monorepo fork often tracks sibling packages that aren't *direct* dependencies of the consumer (e.g. only `@slidev/cli` is a direct dep, while `@slidev/client`/`parser`/`types` come transitively). For those, the switch verbs have no `package.json` entry to rewrite — so they skip it (logging `(transitive; package.json unchanged)`) but still manage the dep's `pnpm-workspace.yaml` / `optimizeDeps` / `pnpm.overrides` references. That's what makes `pds cr slidev -a` work end-to-end: `@slidev/cli` is pinned to its pkg.pr.new build, and the siblings are removed from the workspace so they resolve via that build's rewritten sibling URLs instead of your local checkout.

### Override strategy (`-o`/`--override`)

The default switch strategy rewrites each dep's **`package.json` dependency spec**. That works for a normal single-package dep, but it can't force *transitive* siblings to follow: e.g. with the deck depending only on `@slidev/cli`, switching `@slidev/cli` to a local checkout still leaves `@slidev/client`/`parser`/`types` resolving from upstream npm unless every consumer in the graph also points at your fork.

Mark a dep `override: true` (via `pds init -o` or `pds set -o`, disable with `pds set -O`) and `pds` manages it through **`pnpm.overrides`** (at the workspace root) instead. A `pnpm.overrides` entry forces resolution for the **entire dependency graph**, including transitive siblings — so it delivers your forked packages everywhere, which is exactly what a monorepo fork needs.

With `override: true`, each switch verb rewrites only the single `pnpm.overrides[<name>]` value and leaves the `package.json` dep spec, `pnpm-workspace.yaml`, and `vite.config.ts` untouched (they become a static baseline):

| verb | `pnpm.overrides[<name>]` value |
| --- | --- |
| `pds l` | `link:<relative-path>` (symlink to the local checkout; its own `node_modules` resolves the siblings) |
| `pds cr` | `https://pkg.pr.new/<owner>/<repo>/<npmName>@<sha>` |
| `pds gh` | `https://github.com/<owner>/<repo>#<sha>` |
| `pds gl` | GitLab archive tarball URL |
| `pds npm` | `^<version>` (pins the whole graph to a published version) |

`pds deinit`/`rm` strip the override entry (and the now-empty `pnpm` block). `pds status`/`ls` read the active source from `pnpm.overrides` for override-managed deps (tagged `[override]`), and the local-dependency `check` hook treats a `link:`/`file:` override as "local" too.

This is the recommended setup for toggling a monorepo fork's whole fleet between a local checkout and a SHA-pinned remote build:

```bash
# one-time: mark each fleet member as override-managed
pds set @slidev/cli @slidev/client @slidev/parser @slidev/types -o   # (or pds init -o ...)

pds l  slidev -a    # whole fleet → local checkout (HMR against your clone)
pds cr slidev -a    # whole fleet → SHA-pinned pkg.pr.new build of your fork
```

> **Note:** `pnpm` resolves `link:`/`file:` overrides relative to the workspace root and only honors `pnpm.overrides` declared there, so `pds` always writes the override to the workspace-root `package.json` (the dir holding `pnpm-workspace.yaml`, or the single-package project root). When toggling under `shamefullyHoist: true`, a stale flat symlink can linger; `rm -rf node_modules && pnpm install` clears it.
>
> **Declare your own config deps.** Managing a fork via overrides (rather than as a `pnpm-workspace.yaml` member) means its transitive deps are no longer *hoisted* into your flat `node_modules`. If your **own** config imports one of them — e.g. a `vite.config.ts` doing `import { defineConfig } from 'vite'`, where `vite` used to come transitively from the workspace-membered fork — add it as a direct (dev)dependency. Packages you only use *through* the linked/built fork still resolve via its own tree.

### Auto-configuring a monorepo fleet

You don't have to register each fork sub-package by hand. Point `init` at a **monorepo root** and `pds` expands it into the whole fleet (override-managed), so the consumer never has to know the sub-package layout:

```bash
pds init ../slidev          # registers @slidev/cli, @slidev/client, @slidev/parser, @slidev/types
pds l  slidev -a            # then toggle the fleet as usual
pds cr slidev -a
```

`init <root>` determines the fleet in this order:

1. **Hint file** — `pds.json` at the repo root (or a `"pds"` key in its `package.json`). This is the authoritative, zero-guesswork path: the library/fork declares exactly which packages are consumable and how. Recommended for anything with non-fleet packages (scaffolders, docs, examples) that auto-detect would otherwise sweep in:

   ```json
   // <repo-root>/pds.json
   {
     "strategy": "override",
     "fleet": ["@slidev/cli", "@slidev/client", "@slidev/parser", "@slidev/types"]
   }
   ```

   `strategy` is `"override"` (default for a multi-package fleet) or `"default"`; `fleet` is the npm names to include (omit to take all publishable workspace packages).

2. **Auto-detect** — no hint: `pds` enumerates the workspace (`pnpm-workspace.yaml` `packages:`, or `package.json` `workspaces`) and takes the **publishable** (non-`private`) packages. Multiple members ⇒ `override` strategy. Repo (`github`/`gitlab`) is detected from the root's git remote; each member's `npm` name and `subdir` come from its own `package.json`.

3. **Explicit `-o`** — for a single package (not a monorepo), `pds init -o <path>` / `pds set -o <dep>` opts that one dep into override management.

A plain (non-workspace) package path still inits as a single dep, exactly as before.

### Check status

```bash
pds status           # Show all configured deps
pds status [dep]     # Show specific dep
pds s                # Alias
```

### List configured dependencies

```bash
pds              # defaults to list
pds list         # or pds ls
pds ls kbd prms  # filter to deps matching any substring
pds ls -a        # show both project and global dependencies
pds ls -s local  # show only local deps (useful before pushing)
pds ls -s gh     # show only GitHub-pinned deps (also: gl, npm)
pds ls -v        # include available remote versions (npm, GitHub/GitLab dist SHA + version)
pds ls -av       # combined: all deps, verbose
pds versions     # or pds v (alias for ls -v)
```

The active source is highlighted with a green `*` prefix (plain `*` in non-TTY mode). Positional arguments filter by substring match (case-insensitive), consistent with other `pds` commands. Dep names are colored by type: magenta for globals, yellow for dev deps, cyan for regular deps.

Sort order: global deps first, then regular deps, then dev deps (alphabetical within each group).

Verbose mode (`-v`) shows:
- Local git info (short SHA, dirty indicator)
- `[dev]` / `[global]` tags (colored to match dep name)
- GitHub/GitLab dist branch SHA and version, with pinned vs latest comparison
- Colored `+N` (green, ahead) / `-N` (red, behind) / `+M-N` indicators when pinned differs from latest
- NPM latest version, source SHA, and version delta relative to dist
- Uncommitted dep changes: when a dep's source differs from `HEAD`, shows red `was:` and green `now:` sub-lines with both dist and source (main) SHAs

### Update dependency fields

```bash
pds set <dep> -H user/repo      # Set GitHub repo
pds set <dep> -L user/repo      # Set GitLab repo
pds set <dep> -l ../path        # Set local path
pds set <dep> -n pkg-name       # Set NPM name
pds set <dep> -H ""             # Remove GitHub
pds -g set                      # Update global config (with single dep)
```

### Stop tracking a dependency

```bash
pds deinit [dep]    # or pds di [dep]
pds -g di           # Stop tracking global dep
```

This removes the dependency from `.pds.json` but keeps it in `package.json`.

### Remove a dependency

```bash
pds rm [dep]        # or pds r [dep]
pds -g rm           # Remove global dep
```

This removes the dependency from both `.pds.json` and `package.json`, then runs `pnpm install`.

### Monorepo subdir support

For dependencies that live in a subdirectory of a monorepo, `pds init` auto-detects the subdirectory relative to the git root:

```bash
pds init ../../slidev/packages/slidev    # detects subdir: /packages/slidev
```

When switching to GitHub, the specifier uses pnpm's `&path:` syntax:

```
github:user/repo#sha&path:/packages/slidev
```

The `subdir` field is stored in `.pds.json` and can also be set manually via the config.

### Auto-subdir detection

If `pds` is run from a directory without a `package.json`, and exactly one immediate subdirectory contains a `package.json`, it auto-uses that subdirectory. This is convenient for projects that wrap a JS app inside a parent directory (e.g. containing Docker configs, docs, etc.):

```
my-project/
  Dockerfile
  myapp/           ← auto-detected
    package.json
    .pds.json
```

If multiple subdirectories have `package.json`, `pds` lists them and asks you to `cd` into the right one.

### Git hooks

Prevent accidentally pushing (or committing) with local dependencies:

```bash
pds hooks install    # Install global git hooks
pds hooks uninstall  # Remove them
pds hooks status     # Check installation status
```

Installs both `pre-push` and `pre-commit` hooks via `git config --global core.hooksPath`. By default, the check runs on **pre-push** — local deps are caught before pushing, not before every commit (which would interfere with WIP workflows).

Each hook calls `pds check --hook <type>`, and `pds check` decides whether to run based on the resolved `checkOn` config:

```
project .pds.json checkOn → global config checkOn → default ("pre-push")
```

#### Per-project overrides

Set `"checkOn"` in `.pds.json` (or `.pnpm-dep-source.json`):

```json
{ "checkOn": "pre-commit" }
```

Valid values:
- `"pre-push"` (default) — block on push
- `"pre-commit"` — block on commit
- `"none"` — disable the check entirely

The legacy `"skipCheck": true` is treated as `"checkOn": "none"`.

#### Global default override

Set `"checkOn"` in `~/.config/pnpm-dep-source/config.json` to change the default for all projects.

#### Hook chaining

The hooks chain to:
- Any previously configured `core.hooksPath` (saved and restored on uninstall)
- Local `.git/hooks/` hooks if present (normally ignored when `core.hooksPath` is set)

### Check for local dependencies

```bash
pds check            # Exits non-zero if any deps are local (always runs)
pds check -q         # Quiet mode (exit code only)
pds check --hook pre-push  # Only runs if checkOn resolves to "pre-push"
```

### Vite plugin (experimental)

In some cases, `pds l` with local dependencies can cause Vite to fail to resolve peer imports across symlink boundaries — e.g. duplicate React instances (hooks crash: `Cannot read properties of null (reading 'useRef')`) or unresolved dynamic peer imports. This seems to depend on the project setup and isn't always reproducible.

If you hit this, `pds` ships an experimental Vite plugin that auto-injects `resolve.alias` entries for local deps' peer dependencies. Requires `pnpm-dep-source` as a project devDependency:

```bash
pnpm add -D pnpm-dep-source
```

```ts
// vite.config.ts
import { pdsPlugin } from 'pnpm-dep-source/vite'

export default defineConfig({
  plugins: [react(), pdsPlugin()],
})
```

The plugin reads `.pds.json` at startup and, for each local dep:
- Resolves `peerDependencies` to the consumer's `node_modules/` (prevents duplicate React, etc.)
- Adds the dep to `optimizeDeps.include` (pre-bundles CJS→ESM so `require()` works in the browser)
- Defines `global: 'globalThis'` when any local dep is CJS (no `"type": "module"`)

It's a no-op when no local deps are active, so it's safe to leave in permanently.

Options:
- `root`: project root path (default: `process.cwd()`)
- `extra`: additional modules to alias (e.g. `['plotly.js-dist-min']` for dynamically-imported peers)

See [`specs/done/vite-local-dep-aliases.md`](specs/done/vite-local-dep-aliases.md) and [`specs/done/vite-cjs-compat.md`](specs/done/vite-cjs-compat.md) for background.

### Shell aliases

```bash
eval "$(pds shell-integration)"   # Add to .bashrc/.zshrc
```

Provides aliases like `pdl` (list), `pdla` (list all), `pdll` (list local only), `pdlv` (list verbose), `pdgh` (github), `pdgl` (gitlab), `pdsn` (npm), `pdg` (global mode), etc. Run `pds shell-integration` to see the full list.

### Show pds info

```bash
pds info             # Show version and install source
```

## Config file

The tool stores configuration in `.pds.json` (also supports `.pnpm-dep-source.json` for backwards compatibility):

```json
{
  "dependencies": {
    "@scope/package-name": {
      "localPath": "../../path/to/local",
      "github": "user/repo",
      "gitlab": "user/repo",
      "npm": "@scope/package-name",
      "distBranch": "dist",
      "subdir": "/packages/client",
      "override": true
    }
  },
  "checkOn": "pre-push"
}
```

The `subdir` field is optional and auto-detected during `init` for monorepo packages. The `override` field is optional — when `true`, `pds` manages the dep through `pnpm.overrides` instead of the `package.json` dep spec (see [Override strategy](#override-strategy--o--override)).

Set `"checkOn"` to control when the git hook check runs: `"pre-push"` (default), `"pre-commit"`, or `"none"` to disable. The legacy `"skipCheck": true` is still supported (treated as `"checkOn": "none"`).

## Options

### Top-level options

- `-C, --dir <path>`: Run as if started in `<path>` (like `git -C`). Works with all commands: `pds -C www ls`, `pds -Cwww`, `pdlv -C api`, etc.
- `-g, --global`: Use global config (`~/.config/pnpm-dep-source/config.json`) for CLI tools. Must come before the command: `pds -g ls`, `pds -g gh`, etc.

### Command options

- `-a, --all`: For `list`, show both project and global dependencies. For the switch verbs (`l`/`gh`/`gl`/`g`/`cr`/`n`), treat each query as a regex and switch ALL matching deps (no query → all configured deps)
- `-b, --dist-branch <branch>`: Dist branch name (default: "dist")
- `-D, --dev`: Add as devDependency (for `init` when adding to package.json)
- `-f, --force`: Suppress mismatch warnings in `init`
- `-H, --github <repo>`: GitHub repo (auto-detected from package.json if not specified)
- `-I, --no-install`: Skip running `pnpm install` after changes
- `-k, --keep-going`: Continue past per-dep failures (for the switch verbs; default: stop on first error)
- `-l, --local <path>`: Local path (for `init` with URL, or `set` command)
- `-L, --gitlab <repo>`: GitLab repo (auto-detected from package.json if not specified)
- `-n, --dry-run`: Show what would be installed without making changes (for `gh`/`gl`/`g`/`cr`/`npm`)
- `-o, --override` / `-O, --no-override`: Manage the dep through `pnpm.overrides` (forces the whole graph, incl. transitive monorepo siblings) instead of the `package.json` dep spec (for `init`/`set`; see [Override strategy](#override-strategy--o--override))
- `-r, --ref <ref>`: Git ref, resolved to SHA (for `github`/`gitlab`/`cr` commands)
- `-R, --raw-ref <ref>`: Git ref, used as-is (pin to branch/tag name)
- `-s, --source <source>`: Activate a specific source after `init` (`gh`, `gl`, `cr`, `npm`, or `g` to auto-detect)
- `-v, --verbose`: Show available remote versions (for `list`)

## Global CLI tools

For managing globally-installed CLI tools, use `-g` before the command:

```bash
# Initialize a global CLI tool
pds -g init /path/to/local/cli -H github-user/repo

# List global deps
pds -g ls
pds -g               # shorthand for pds -g ls

# Switch global install source
pds -g gh            # Install from GitHub dist branch
pds -g l             # Install from local directory
pds -g n             # Install from NPM
```

Global config is stored at `~/.config/pnpm-dep-source/config.json`.

## Recommended workflow

1. **Local development**: Use `pds local <dep>` to develop against a local copy
2. **Integration testing**: Push to GitHub/GitLab, build a dist branch, use `pds gh <dep>` or `pds gl <dep>` to test
3. **Release**: Publish to NPM, switch consumers to `pds npm <dep>`

### Setting up a dist branch

Add a workflow to your library that builds and pushes to a `dist` branch:

```yaml
# .github/workflows/build-dist.yml
name: Build dist branch
on:
  workflow_dispatch:
    inputs:
      src:
        description: 'Source ref to build from'
        required: false
      dst:
        description: 'Dist branch name (default: dist)'
        required: false
jobs:
  build-dist:
    uses: runsascoded/npm-dist/.github/workflows/build-dist.yml@v1
    with:
      source_ref: ${{ inputs.src }}
      dist_branch: ${{ inputs.dst }}
```

See [npm-dist] for more options.

[npm-dist]: https://github.com/runsascoded/npm-dist

## Requirements

- [gh CLI] for GitHub ref resolution
- [glab CLI] for GitLab ref resolution

[gh CLI]: https://cli.github.com/
[glab CLI]: https://gitlab.com/gitlab-org/cli

## Self-hosting

`pds` can manage itself! Clone the repo and use the global (`-g`) commands to switch between local development, dist branch testing, and NPM releases:

```bash
# Clone and initialize
git clone https://github.com/runsascoded/pnpm-dep-source.git
cd pnpm-dep-source
pnpm install && pnpm build

# Register pds as its own global dependency
pds -g init .

# Develop locally
pds -g l    # installs from local ./dist

# Test dist branch
pds -g gh   # installs from GitHub dist branch

# Use NPM release
pds -g n    # installs from NPM
```

## License

MIT
