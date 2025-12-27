#!/usr/bin/env node

import { program } from 'commander'
import { execSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'

const CONFIG_FILE = '.pnpm-dep-source.json'

interface DepConfig {
  localPath: string
  github?: string       // e.g. "runsascoded/use-hotkeys"
  npm?: string          // e.g. "@rdub/use-hotkeys" (defaults to package name from local)
  distBranch?: string   // defaults to "dist"
}

interface Config {
  dependencies: Record<string, DepConfig>
}

// Find project root (directory containing package.json)
function findProjectRoot(startDir: string = process.cwd()): string {
  let dir = startDir
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) {
      return dir
    }
    dir = dirname(dir)
  }
  throw new Error('Could not find project root (no package.json found)')
}

function loadConfig(projectRoot: string): Config {
  const configPath = join(projectRoot, CONFIG_FILE)
  if (!existsSync(configPath)) {
    return { dependencies: {} }
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

function saveConfig(projectRoot: string, config: Config): void {
  const configPath = join(projectRoot, CONFIG_FILE)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}

function loadPackageJson(projectRoot: string): Record<string, unknown> {
  const pkgPath = join(projectRoot, 'package.json')
  return JSON.parse(readFileSync(pkgPath, 'utf-8'))
}

function savePackageJson(projectRoot: string, pkg: Record<string, unknown>): void {
  const pkgPath = join(projectRoot, 'package.json')
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}

function removePnpmOverride(pkg: Record<string, unknown>, depName: string): void {
  const pnpm = pkg.pnpm as Record<string, unknown> | undefined
  if (!pnpm) return

  const overrides = pnpm.overrides as Record<string, string> | undefined
  if (!overrides || !(depName in overrides)) return

  delete overrides[depName]

  // Clean up empty overrides object
  if (Object.keys(overrides).length === 0) {
    delete pnpm.overrides
  }
}

interface WorkspaceConfig {
  packages?: string[]
}

function loadWorkspaceYaml(projectRoot: string): WorkspaceConfig | null {
  const wsPath = join(projectRoot, 'pnpm-workspace.yaml')
  if (!existsSync(wsPath)) {
    return null
  }
  // Simple YAML parser for our use case
  const content = readFileSync(wsPath, 'utf-8')
  const packages: string[] = []
  let inPackages = false
  for (const line of content.split('\n')) {
    if (line.startsWith('packages:')) {
      inPackages = true
      continue
    }
    if (inPackages && line.match(/^\s+-\s+/)) {
      const pkg = line.replace(/^\s+-\s+/, '').trim()
      packages.push(pkg)
    } else if (inPackages && !line.match(/^\s/) && line.trim()) {
      inPackages = false
    }
  }
  return { packages }
}

function saveWorkspaceYaml(projectRoot: string, config: WorkspaceConfig | null): void {
  const wsPath = join(projectRoot, 'pnpm-workspace.yaml')
  if (!config || !config.packages || config.packages.length === 0) {
    if (existsSync(wsPath)) {
      execSync(`rm ${wsPath}`)
    }
    return
  }
  const content = 'packages:\n' + config.packages.map(p => `  - ${p}`).join('\n') + '\n'
  writeFileSync(wsPath, content)
}

function findMatchingDep(config: Config, query: string): [string, DepConfig] {
  const matches = Object.entries(config.dependencies).filter(([name]) =>
    name.toLowerCase().includes(query.toLowerCase())
  )
  if (matches.length === 0) {
    throw new Error(`No dependency matching "${query}" found in config`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous match "${query}" - matches: ${matches.map(([n]) => n).join(', ')}`
    )
  }
  return matches[0]
}

function updatePackageJsonDep(
  pkg: Record<string, unknown>,
  depName: string,
  specifier: string,
): void {
  const deps = pkg.dependencies as Record<string, string> | undefined
  const devDeps = pkg.devDependencies as Record<string, string> | undefined

  if (deps && depName in deps) {
    deps[depName] = specifier
  } else if (devDeps && depName in devDeps) {
    devDeps[depName] = specifier
  } else {
    throw new Error(`Dependency "${depName}" not found in package.json`)
  }
}

function getCurrentSource(pkg: Record<string, unknown>, depName: string): string {
  const deps = pkg.dependencies as Record<string, string> | undefined
  const devDeps = pkg.devDependencies as Record<string, string> | undefined
  return deps?.[depName] ?? devDeps?.[depName] ?? '(not found)'
}

function updateViteConfig(projectRoot: string, depName: string, exclude: boolean): void {
  const vitePath = join(projectRoot, 'vite.config.ts')
  if (!existsSync(vitePath)) {
    return // No vite config, nothing to do
  }

  let content = readFileSync(vitePath, 'utf-8')

  if (exclude) {
    // Add to optimizeDeps.exclude if not present
    if (content.includes('optimizeDeps:')) {
      if (!content.includes(`'${depName}'`) && !content.includes(`"${depName}"`)) {
        // Add to existing exclude array
        content = content.replace(
          /exclude:\s*\[([^\]]*)\]/,
          (_, inner) => {
            const items = inner.trim() ? inner.trim() + `, '${depName}'` : `'${depName}'`
            return `exclude: [${items}]`
          }
        )
        if (!content.includes(`'${depName}'`)) {
          // No exclude array, add one
          content = content.replace(
            /optimizeDeps:\s*\{([^}]*)\}/,
            (_, inner) => `optimizeDeps: {${inner.trimEnd()}\n    exclude: ['${depName}'],\n  }`
          )
        }
      }
    } else {
      // Add optimizeDeps section before closing })
      content = content.replace(
        /}\)\s*$/,
        `  optimizeDeps: {\n    exclude: ['${depName}'],\n  },\n})\n`
      )
    }
  } else {
    // Remove from optimizeDeps.exclude
    // Remove the dep from exclude array
    content = content.replace(
      new RegExp(`['"]${depName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"],?\\s*`, 'g'),
      ''
    )
    // Clean up empty exclude arrays
    content = content.replace(/\s*exclude:\s*\[\s*\],?/g, '')
    // Clean up empty optimizeDeps (including leading whitespace)
    content = content.replace(/\s*optimizeDeps:\s*\{\s*\},?/g, '')
  }

  writeFileSync(vitePath, content)
}

function resolveGitHubRef(repo: string, ref: string): string {
  // Use gh api to resolve ref to SHA from GitHub
  const result = spawnSync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to resolve GitHub ref "${ref}" for ${repo}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function getLocalPackageName(localPath: string): string {
  const pkgPath = join(localPath, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json found at ${localPath}`)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  return pkg.name
}

function runPnpmInstall(projectRoot: string): void {
  console.log('Running pnpm install...')
  execSync('pnpm install', { cwd: projectRoot, stdio: 'inherit' })
}

function getLatestNpmVersion(packageName: string): string {
  const result = spawnSync('npm', ['view', packageName, 'version'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to get latest version for ${packageName}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

program
  .name('pnpm-dep-source')
  .description('Switch pnpm dependencies between local, GitHub, and NPM sources')
  .version('0.1.1')

program
  .command('init <local-path>')
  .description('Initialize a dependency in the config')
  .option('-g, --github <repo>', 'GitHub repo (e.g. "user/repo")')
  .option('-n, --npm <name>', 'NPM package name (defaults to name from local package.json)')
  .option('-b, --dist-branch <branch>', 'Git branch for dist builds', 'dist')
  .action((localPath: string, options: { github?: string; npm?: string; distBranch: string }) => {
    const projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    const absLocalPath = resolve(localPath)
    const relLocalPath = relative(projectRoot, absLocalPath)

    const pkgName = getLocalPackageName(absLocalPath)
    const npmName = options.npm ?? pkgName

    config.dependencies[pkgName] = {
      localPath: relLocalPath,
      github: options.github,
      npm: npmName,
      distBranch: options.distBranch,
    }

    saveConfig(projectRoot, config)
    console.log(`Initialized ${pkgName}:`)
    console.log(`  Local path: ${relLocalPath}`)
    if (options.github) console.log(`  GitHub: ${options.github}`)
    console.log(`  NPM: ${npmName}`)
    console.log(`  Dist branch: ${options.distBranch}`)
  })

program
  .command('list')
  .alias('ls')
  .description('List configured dependencies and their current sources')
  .action(() => {
    const projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    const pkg = loadPackageJson(projectRoot)

    if (Object.keys(config.dependencies).length === 0) {
      console.log('No dependencies configured. Use "pnpm-dep-source init <path>" to add one.')
      return
    }

    for (const [name, dep] of Object.entries(config.dependencies)) {
      const current = getCurrentSource(pkg, name)
      console.log(`${name}:`)
      console.log(`  Current: ${current}`)
      console.log(`  Local: ${dep.localPath}`)
      if (dep.github) console.log(`  GitHub: ${dep.github}`)
      if (dep.npm) console.log(`  NPM: ${dep.npm}`)
    }
  })

program
  .command('local <dep>')
  .alias('l')
  .description('Switch dependency to local directory')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string, options: { install: boolean }) => {
    const projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    const [depName, depConfig] = findMatchingDep(config, depQuery)

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, 'workspace:*')
    savePackageJson(projectRoot, pkg)

    // Update pnpm-workspace.yaml
    const ws = loadWorkspaceYaml(projectRoot) ?? { packages: ['.'] }
    if (!ws.packages) ws.packages = ['.']
    if (!ws.packages.includes('.')) ws.packages.unshift('.')
    if (!ws.packages.includes(depConfig.localPath)) {
      ws.packages.push(depConfig.localPath)
    }
    saveWorkspaceYaml(projectRoot, ws)

    // Update vite.config.ts
    updateViteConfig(projectRoot, depName, true)

    console.log(`Switched ${depName} to local: ${depConfig.localPath}`)

    if (options.install) {
      runPnpmInstall(projectRoot)
    }
  })

program
  .command('github <dep> [ref]')
  .aliases(['gh', 'g'])
  .description('Switch dependency to GitHub ref (defaults to dist branch HEAD)')
  .option('-s, --sha', 'Resolve ref to SHA')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string, ref: string | undefined, options: { sha: boolean; install: boolean }) => {
    const projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    const [depName, depConfig] = findMatchingDep(config, depQuery)

    if (!depConfig.github) {
      throw new Error(`No GitHub repo configured for ${depName}. Use "pnpm-dep-source init" with --github`)
    }

    const distBranch = depConfig.distBranch ?? 'dist'

    let resolvedRef: string
    if (!ref) {
      // No ref provided: use dist branch, resolve to SHA
      resolvedRef = resolveGitHubRef(depConfig.github, distBranch)
    } else if (options.sha) {
      // Ref provided with -s: resolve to SHA via GitHub API
      resolvedRef = resolveGitHubRef(depConfig.github, ref)
    } else {
      // Ref provided without -s: use as-is
      resolvedRef = ref
    }

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, `github:${depConfig.github}#${resolvedRef}`)
    removePnpmOverride(pkg, depName)
    savePackageJson(projectRoot, pkg)

    // Remove from pnpm-workspace.yaml
    const ws = loadWorkspaceYaml(projectRoot)
    if (ws?.packages) {
      ws.packages = ws.packages.filter(p => p !== depConfig.localPath)
      if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
        saveWorkspaceYaml(projectRoot, null)
      } else {
        saveWorkspaceYaml(projectRoot, ws)
      }
    }

    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false)

    console.log(`Switched ${depName} to GitHub: ${depConfig.github}#${resolvedRef}`)

    if (options.install) {
      runPnpmInstall(projectRoot)
    }
  })

program
  .command('npm <dep> [version]')
  .alias('n')
  .description('Switch dependency to NPM (defaults to latest)')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string, version: string | undefined, options: { install: boolean }) => {
    const projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    const [depName, depConfig] = findMatchingDep(config, depQuery)

    const npmName = depConfig.npm ?? depName
    // Resolve latest version from NPM if not specified
    const resolvedVersion = version ?? getLatestNpmVersion(npmName)
    const specifier = `^${resolvedVersion}`

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, specifier)
    removePnpmOverride(pkg, depName)
    savePackageJson(projectRoot, pkg)

    // Remove from pnpm-workspace.yaml
    const ws = loadWorkspaceYaml(projectRoot)
    if (ws?.packages) {
      ws.packages = ws.packages.filter(p => p !== depConfig.localPath)
      if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
        saveWorkspaceYaml(projectRoot, null)
      } else {
        saveWorkspaceYaml(projectRoot, ws)
      }
    }

    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false)

    console.log(`Switched ${depName} to NPM: ${specifier}`)

    if (options.install) {
      runPnpmInstall(projectRoot)
    }
  })

program
  .command('status [dep]')
  .alias('s')
  .description('Show current source for dependency (or all if none specified)')
  .action((depQuery?: string) => {
    const projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    const pkg = loadPackageJson(projectRoot)

    const deps = depQuery
      ? [findMatchingDep(config, depQuery)]
      : Object.entries(config.dependencies)

    for (const [name] of deps) {
      const current = getCurrentSource(pkg, name)
      let sourceType = 'unknown'
      if (current === 'workspace:*') sourceType = 'local'
      else if (current.startsWith('github:')) sourceType = 'github'
      else if (current.match(/^\^?\d|^latest/)) sourceType = 'npm'

      console.log(`${name}: ${sourceType} (${current})`)
    }
  })

program.parse()
