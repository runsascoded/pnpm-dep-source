# pnpm-dep-source

CLI to switch pnpm dependencies between local, GitHub, GitLab, and NPM sources.

## Installation

```bash
npm install -g pnpm-dep-source
# or
pnpm add -g pnpm-dep-source
```

## Usage

### Initialize a dependency

```bash
# In your project directory
pnpm-dep-source init ../../path/to/local/pkg -g github-user/repo

# Or with alias
pds init ../../path/to/local/pkg -g github-user/repo

# With GitLab
pds init ../../path/to/local/pkg -l gitlab-user/repo
```

### Switch to local development

```bash
pds local <dep>    # or pds l <dep>
```

This will:
- Set `package.json` dependency to `workspace:*`
- Create/update `pnpm-workspace.yaml` with the local path
- Add to `vite.config.ts` `optimizeDeps.exclude` (if vite config exists)
- Run `pnpm install`

### Switch to GitHub

```bash
pds github <dep>           # Uses dist branch HEAD (resolved to SHA)
pds github <dep> main      # Uses specific ref
pds gh <dep> -s v1.0.0     # Resolves tag to SHA
```

This will:
- Set `package.json` dependency to `github:user/repo#sha`
- Remove local path from `pnpm-workspace.yaml`
- Remove from `vite.config.ts` `optimizeDeps.exclude`
- Run `pnpm install`

### Switch to GitLab

```bash
pds gitlab <dep>           # Uses dist branch HEAD (resolved to SHA)
pds gitlab <dep> main      # Uses specific ref
pds gl <dep> -s v1.0.0     # Resolves tag to SHA
```

This will:
- Set `package.json` dependency to GitLab tarball URL
- Remove local path from `pnpm-workspace.yaml`
- Remove from `vite.config.ts` `optimizeDeps.exclude`
- Run `pnpm install`

Note: GitLab uses tarball URLs (e.g. `https://gitlab.com/user/repo/-/archive/ref/repo-ref.tar.gz`) since pnpm doesn't support `gitlab:` prefix.

### Switch to NPM

```bash
pds npm <dep>              # Latest version
pds npm <dep> 1.2.3        # Specific version
pds n <dep>                # Alias
```

### Check status

```bash
pds status           # Show all configured deps
pds status <dep>     # Show specific dep
pds s                # Alias
```

### List configured dependencies

```bash
pds list    # or pds ls
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
      "distBranch": "dist"
    }
  }
}
```

## Options

- `-I, --no-install`: Skip running `pnpm install` after changes
- `-s, --sha`: Resolve git ref to SHA (for `github`/`gitlab` commands)
- `-b, --dist-branch <branch>`: Dist branch name (default: "dist")
- `-g, --github <repo>`: GitHub repo for `init` command
- `-l, --gitlab <repo>`: GitLab repo for `init` command
- `-n, --npm <name>`: NPM package name for `init` command

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

## License

MIT
