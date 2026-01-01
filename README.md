# pnpm-dep-source

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
# From local path - auto-detects GitHub/GitLab from package.json repository field
pds init ../../path/to/local/pkg

# From GitHub/GitLab URL
pds init https://github.com/user/repo
pds init https://gitlab.com/user/repo

# Override or specify repo explicitly
pds init ../../path/to/local/pkg -H github-user/repo
pds init ../../path/to/local/pkg -L gitlab-user/repo

# Global CLI tools (uses ~/.config/pnpm-dep-source/config.json)
pds init /path/to/local/cli -g
```

`init` also **auto-activates** the dependency if it exists in `package.json`:
- Local path → switches to `workspace:*` mode
- GitHub URL → switches to `github:user/repo#sha`
- GitLab URL → switches to GitLab tarball URL

Use `-I` to skip activation and just save config.

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

### Switch to GitHub

```bash
pds github [dep]              # Uses dist branch HEAD (resolved to SHA)
pds gh [dep] -r v1.0.0        # Resolves ref to SHA
pds gh [dep] -R dist          # Uses ref as-is (pin to branch name)
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
```

### Check status

```bash
pds status           # Show all configured deps
pds status [dep]     # Show specific dep
pds s                # Alias
```

### List configured dependencies

```bash
pds list    # or pds ls
```

### Update dependency fields

```bash
pds set <dep> -H user/repo      # Set GitHub repo
pds set <dep> -L user/repo      # Set GitLab repo
pds set <dep> -l ../path        # Set local path
pds set <dep> -n pkg-name       # Set NPM name
pds set <dep> -H ""             # Remove GitHub
pds set -g                      # Update global config (with single dep)
```

### Remove a dependency from config

```bash
pds deinit [dep]    # or pds rm [dep]
pds rm -g           # Remove from global config
```

This removes the dependency from `.pnpm-dep-source.json` but does not modify `package.json`.

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
      "distBranch": "dist"
    }
  }
}
```

## Options

- `-b, --dist-branch <branch>`: Dist branch name (default: "dist")
- `-f, --force`: Suppress mismatch warnings in `init`
- `-g, --global`: Use global config (`~/.config/pnpm-dep-source/config.json`) for CLI tools
- `-H, --github <repo>`: GitHub repo (auto-detected from package.json if not specified)
- `-I, --no-install`: Skip running `pnpm install` after changes
- `-l, --local <path>`: Local path (for `init` with URL, or `set` command)
- `-L, --gitlab <repo>`: GitLab repo (auto-detected from package.json if not specified)
- `-n, --npm <name>`: NPM package name (defaults to package name)
- `-r, --ref <ref>`: Git ref, resolved to SHA (for `github`/`gitlab` commands)
- `-R, --raw-ref <ref>`: Git ref, used as-is (pin to branch/tag name)

## Global CLI tools

For managing globally-installed CLI tools, use `-g` with all commands:

```bash
# Initialize a global CLI tool
pds init /path/to/local/cli -g -H github-user/repo

# List global deps
pds ls -g

# Switch global install source
pds gh -g            # Install from GitHub dist branch
pds l -g             # Install from local directory
pds n -g             # Install from NPM
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
    uses: runsascoded/gh-pnpm-dist/.github/workflows/build-dist.yml@v1
    with:
      source_ref: ${{ inputs.src }}
      dist_branch: ${{ inputs.dst }}
```

See [gh-pnpm-dist] for more options.

[gh-pnpm-dist]: https://github.com/runsascoded/gh-pnpm-dist

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
pds init . -g

# Develop locally
pds l -g    # installs from local ./dist

# Test dist branch
pds gh -g   # installs from GitHub dist branch

# Use NPM release
pds n -g    # installs from NPM
```

## License

MIT
