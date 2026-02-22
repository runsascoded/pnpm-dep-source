# pnpm-dep-source

[![npm version](https://img.shields.io/npm/v/pnpm-dep-source)](https://www.npmjs.com/package/pnpm-dep-source)

CLI to switch pnpm dependencies between local, GitHub / GitLab, and NPM sources.

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

# Global CLI tools (uses ~/.config/pnpm-dep-source/config.json)
pds -g init /path/to/local/cli
```

`init` **adds the dependency to `package.json`** if not present, then **auto-activates**:
- Local path → switches to `workspace:*` mode
- GitHub URL → switches to `github:user/repo#sha`
- GitLab URL → switches to GitLab tarball URL

Use `-D` to add as a devDependency, or `-I` to skip adding/activation entirely.

### Switch to local development

```bash
pds local [dep]    # or pds l [dep]
```

Note: `[dep]` is optional if only one dependency is configured.

This will:
- Set `package.json` dependency to `workspace:*`
- Create/update `pnpm-workspace.yaml` with the local path
- Add to `vite.config.ts` `optimizeDeps.exclude` (if vite config exists)
- Run `pnpm install`

### Switch to GitHub or GitLab (auto-detect)

```bash
pds g [dep]                   # Auto-detects GitHub or GitLab (uses dist branch HEAD)
pds g [dep] -r v1.0.0         # Resolves ref to SHA
pds g [dep] -R dist           # Uses ref as-is (pin to branch name)
pds g [dep] -n                # Dry-run: show what would be installed
```

Errors if neither or both are configured; use `pds gh` or `pds gl` explicitly in that case.

### Switch to GitHub

```bash
pds github [dep]              # Uses dist branch HEAD (resolved to SHA)
pds gh [dep] -r v1.0.0        # Resolves ref to SHA
pds gh [dep] -R dist          # Uses ref as-is (pin to branch name)
pds gh [dep] -n               # Dry-run: show what would be installed
```

This will:
- Set `package.json` dependency to `github:user/repo#sha`
- Remove local path from `pnpm-workspace.yaml`
- Remove from `vite.config.ts` `optimizeDeps.exclude`
- Run `pnpm install`

### Switch to GitLab

```bash
pds gitlab [dep]              # Uses dist branch HEAD (resolved to SHA)
pds gl [dep] -r v1.0.0        # Resolves ref to SHA
pds gl [dep] -R dist          # Uses ref as-is (pin to branch name)
pds gl [dep] -n               # Dry-run: show what would be installed
```

This will:
- Set `package.json` dependency to GitLab tarball URL
- Remove local path from `pnpm-workspace.yaml`
- Remove from `vite.config.ts` `optimizeDeps.exclude`
- Run `pnpm install`

Note: GitLab uses tarball URLs (e.g. `https://gitlab.com/user/repo/-/archive/ref/repo-ref.tar.gz`) since pnpm doesn't support `gitlab:` prefix.

### Switch to NPM

```bash
pds npm [dep]              # Latest version
pds npm [dep] [version]    # Specific version
pds n 1.2.3                # With one dep, arg is treated as version
pds n [dep] -n             # Dry-run: show what would be installed
```

### Check status

```bash
pds status           # Show all configured deps
pds status [dep]     # Show specific dep
pds s                # Alias
```

### List configured dependencies

```bash
pds         # defaults to list
pds list    # or pds ls
pds ls -a   # show both project and global dependencies
pds ls -v   # include available remote versions (npm, GitHub/GitLab dist SHA + version)
pds ls -av  # combined: all deps, verbose
pds versions  # or pds v (alias for ls -v)
```

The active source is highlighted with a green label (or `>` prefix in non-TTY mode). Verbose mode shows:
- Local git info (short SHA, dirty indicator)
- `[dev]` indicator for devDependencies
- Remote dist branch SHA and version (for at-a-glance staleness checks)

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

This removes the dependency from `.pnpm-dep-source.json` but keeps it in `package.json`.

### Remove a dependency

```bash
pds rm [dep]        # or pds r [dep]
pds -g rm           # Remove global dep
```

This removes the dependency from both `.pnpm-dep-source.json` and `package.json`, then runs `pnpm install`.

### Monorepo subdir support

For dependencies that live in a subdirectory of a monorepo, `pds init` auto-detects the subdirectory relative to the git root:

```bash
pds init ../../slidev/packages/slidev    # detects subdir: /packages/slidev
```

When switching to GitHub, the specifier uses pnpm's `&path:` syntax:

```
github:user/repo#sha&path:/packages/slidev
```

The `subdir` field is stored in `.pnpm-dep-source.json` and can also be set manually via the config.

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

### Shell aliases

```bash
eval "$(pds shell-integration)"   # Add to .bashrc/.zshrc
```

Provides aliases like `pdl` (list), `pdla` (list all), `pdlv` (list verbose), `pdgh` (github), `pdgl` (gitlab), `pdsn` (npm), `pdg` (global mode), etc. Run `pds shell-integration` to see the full list.

### Show pds info

```bash
pds info             # Show version and install source
```

## Config file

The tool stores configuration in `.pnpm-dep-source.json`:

```json
{
  "dependencies": {
    "@scope/package-name": {
      "localPath": "../../path/to/local",
      "github": "user/repo",
      "gitlab": "user/repo",
      "npm": "@scope/package-name",
      "distBranch": "dist",
      "subdir": "/packages/client"
    }
  },
  "checkOn": "pre-push"
}
```

The `subdir` field is optional and auto-detected during `init` for monorepo packages.

Set `"checkOn"` to control when the git hook check runs: `"pre-push"` (default), `"pre-commit"`, or `"none"` to disable. The legacy `"skipCheck": true` is still supported (treated as `"checkOn": "none"`).

## Options

### Top-level options

- `-g, --global`: Use global config (`~/.config/pnpm-dep-source/config.json`) for CLI tools. Must come before the command: `pds -g ls`, `pds -g gh`, etc.

### Command options

- `-a, --all`: Show both project and global dependencies (for `list`)
- `-b, --dist-branch <branch>`: Dist branch name (default: "dist")
- `-D, --dev`: Add as devDependency (for `init` when adding to package.json)
- `-f, --force`: Suppress mismatch warnings in `init`
- `-H, --github <repo>`: GitHub repo (auto-detected from package.json if not specified)
- `-I, --no-install`: Skip running `pnpm install` after changes
- `-l, --local <path>`: Local path (for `init` with URL, or `set` command)
- `-L, --gitlab <repo>`: GitLab repo (auto-detected from package.json if not specified)
- `-n, --dry-run`: Show what would be installed without making changes (for `gh`/`gl`/`g`/`npm`)
- `-r, --ref <ref>`: Git ref, resolved to SHA (for `github`/`gitlab` commands)
- `-R, --raw-ref <ref>`: Git ref, used as-is (pin to branch/tag name)
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
