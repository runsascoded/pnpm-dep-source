# pnpm-dep-source

CLI to switch pnpm dependencies between local, GitHub, and NPM sources.

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

### Switch to GitHub SHA

```bash
pds github <dep>           # Uses r/dist branch HEAD (resolved to SHA)
pds github <dep> main      # Uses specific ref
pds gh <dep> -s v1.0.0     # Resolves tag to SHA
```

This will:
- Set `package.json` dependency to `github:user/repo#sha`
- Remove local path from `pnpm-workspace.yaml`
- Remove from `vite.config.ts` `optimizeDeps.exclude`
- Run `pnpm install`

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
      "npm": "@scope/package-name",
      "distBranch": "dist"
    }
  }
}
```

## Options

- `-I, --no-install`: Skip running `pnpm install` after changes
- `-s, --sha`: Resolve git ref to SHA (for `github` command)
- `-g, --github <repo>`: GitHub repo for `init` command
- `-n, --npm <name>`: NPM package name for `init` command
- `-b, --dist-branch <branch>`: Dist branch name (default: "dist")

## License

MIT
