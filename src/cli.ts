#!/usr/bin/env node

import { program } from 'commander'
import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
const VERSION = pkgJson.version as string

const CONFIG_FILE = '.pnpm-dep-source.json'
const GLOBAL_CONFIG_DIR = join(homedir(), '.config', 'pnpm-dep-source')
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json')

interface DepConfig {
  localPath: string
  github?: string       // e.g. "runsascoded/use-kbd"
  gitlab?: string       // e.g. "runsascoded/screenshots"
  npm?: string          // e.g. "use-kbd" (defaults to package name from local)
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

function loadGlobalConfig(): Config {
  if (!existsSync(GLOBAL_CONFIG_FILE)) {
    return { dependencies: {} }
  }
  return JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, 'utf-8'))
}

function saveGlobalConfig(config: Config): void {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
  }
  writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
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

function findMatchingDep(config: Config, query?: string): [string, DepConfig] {
  const deps = Object.entries(config.dependencies)

  if (!query) {
    // No query - default to single dep if there's exactly one
    if (deps.length === 0) {
      throw new Error('No dependencies configured. Use "pds init <path>" to add one.')
    }
    if (deps.length === 1) {
      return deps[0]
    }
    throw new Error(
      `Multiple dependencies configured. Specify one: ${deps.map(([n]) => n).join(', ')}`
    )
  }

  const matches = deps.filter(([name]) =>
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

function resolveGitLabRef(repo: string, ref: string): string {
  // Use glab api to resolve ref to SHA from GitLab
  const encodedRepo = encodeURIComponent(repo)
  const result = spawnSync('glab', ['api', `projects/${encodedRepo}/repository/commits/${ref}`], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to resolve GitLab ref "${ref}" for ${repo}: ${result.stderr}`)
  }
  try {
    const data = JSON.parse(result.stdout)
    return data.id
  } catch {
    throw new Error(`Failed to parse GitLab API response for ${repo}: ${result.stdout}`)
  }
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

function runGlobalInstall(specifier: string): void {
  console.log(`Running pnpm add -g ${specifier}...`)
  execSync(`pnpm add -g ${specifier}`, { stdio: 'inherit' })
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

function getGlobalInstallSource(packageName = 'pnpm-dep-source'): { source: string; specifier: string } | null {
  const result = spawnSync('pnpm', ['list', '-g', packageName, '--json'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    return null
  }
  try {
    const data = JSON.parse(result.stdout)
    // pnpm list -g --json returns array of global packages
    const pkg = data[0]?.dependencies?.[packageName]
    if (!pkg) return null

    const version = pkg.version || ''
    const resolved = pkg.resolved || ''

    // Local file install: version is "file:..." path
    if (version.startsWith('file:')) {
      // Resolve relative path to absolute (relative to pnpm global dir)
      const filePath = version.slice(5) // remove "file:"
      const globalDir = data[0]?.path || ''
      const absPath = globalDir ? resolve(globalDir, filePath) : filePath
      return { source: 'local', specifier: absPath }
    }

    // Check resolved URL for source detection
    if (resolved.includes('codeload.github.com') || resolved.includes('github.com')) {
      // Extract SHA from GitHub URL
      const shaMatch = resolved.match(/([a-f0-9]{40})/)
      const sha = shaMatch ? shaMatch[1].slice(0, 7) : ''
      return { source: 'github', specifier: `${sha}; ${version}` }
    } else if (resolved.includes('gitlab.com') && resolved.includes('/-/archive/')) {
      // Extract ref from GitLab tarball URL
      const refMatch = resolved.match(/\/-\/archive\/([^/]+)\//)
      const ref = refMatch ? refMatch[1].slice(0, 7) : ''
      return { source: 'gitlab', specifier: `${ref}; ${version}` }
    } else if (version) {
      return { source: 'npm', specifier: version }
    }
    return null
  } catch {
    return null
  }
}

program
  .name('pnpm-dep-source')
  .description('Switch pnpm dependencies between local, GitHub, and NPM sources')
  .version(VERSION)

program
  .command('init <local-path>')
  .description('Initialize a dependency in the config')
  .option('-b, --dist-branch <branch>', 'Git branch for dist builds', 'dist')
  .option('-g, --global', 'Add to global config (for CLI tools)')
  .option('-H, --github <repo>', 'GitHub repo (e.g. "user/repo")')
  .option('-L, --gitlab <repo>', 'GitLab repo (e.g. "user/repo")')
  .option('-n, --npm <name>', 'NPM package name (defaults to name from local package.json)')
  .action((localPath: string, options: { github?: string; global?: boolean; gitlab?: string; npm?: string; distBranch: string }) => {
    const absLocalPath = resolve(localPath)
    const pkgName = getLocalPackageName(absLocalPath)
    const npmName = options.npm ?? pkgName

    if (options.global) {
      const config = loadGlobalConfig()
      config.dependencies[pkgName] = {
        localPath: absLocalPath,  // Use absolute path for global config
        github: options.github,
        gitlab: options.gitlab,
        npm: npmName,
        distBranch: options.distBranch,
      }
      saveGlobalConfig(config)
      console.log(`Initialized ${pkgName} (global):`)
      console.log(`  Local path: ${absLocalPath}`)
      if (options.github) console.log(`  GitHub: ${options.github}`)
      if (options.gitlab) console.log(`  GitLab: ${options.gitlab}`)
      console.log(`  NPM: ${npmName}`)
      console.log(`  Dist branch: ${options.distBranch}`)
      return
    }

    const projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    const relLocalPath = relative(projectRoot, absLocalPath)

    config.dependencies[pkgName] = {
      localPath: relLocalPath,
      github: options.github,
      gitlab: options.gitlab,
      npm: npmName,
      distBranch: options.distBranch,
    }

    saveConfig(projectRoot, config)
    console.log(`Initialized ${pkgName}:`)
    console.log(`  Local path: ${relLocalPath}`)
    if (options.github) console.log(`  GitHub: ${options.github}`)
    if (options.gitlab) console.log(`  GitLab: ${options.gitlab}`)
    console.log(`  NPM: ${npmName}`)
    console.log(`  Dist branch: ${options.distBranch}`)
  })

program
  .command('list')
  .alias('ls')
  .description('List configured dependencies and their current sources')
  .option('-g, --global', 'List global dependencies')
  .action((options: { global?: boolean }) => {
    if (options.global) {
      const config = loadGlobalConfig()

      if (Object.keys(config.dependencies).length === 0) {
        console.log('No global dependencies configured. Use "pds init -G <path>" to add one.')
        return
      }

      for (const [name, dep] of Object.entries(config.dependencies)) {
        const installSource = getGlobalInstallSource(name)
        console.log(`${name}:`)
        console.log(`  Current: ${installSource ? `${installSource.source} (${installSource.specifier})` : '(not installed)'}`)
        console.log(`  Local: ${dep.localPath}`)
        if (dep.github) console.log(`  GitHub: ${dep.github}`)
        if (dep.gitlab) console.log(`  GitLab: ${dep.gitlab}`)
        if (dep.npm) console.log(`  NPM: ${dep.npm}`)
      }
      return
    }

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
      if (dep.gitlab) console.log(`  GitLab: ${dep.gitlab}`)
      if (dep.npm) console.log(`  NPM: ${dep.npm}`)
    }
  })

program
  .command('local [dep]')
  .alias('l')
  .description('Switch dependency to local directory')
  .option('-g, --global', 'Install globally (uses global config)')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string | undefined, options: { global: boolean; install: boolean }) => {
    if (options.global) {
      const config = loadGlobalConfig()
      const [depName, depConfig] = findMatchingDep(config, depQuery)
      runGlobalInstall(`file:${depConfig.localPath}`)
      console.log(`Installed ${depName} globally from local: ${depConfig.localPath}`)
      return
    }

    const projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    const [depName, depConfig] = findMatchingDep(config, depQuery)

    const absLocalPath = resolve(projectRoot, depConfig.localPath)

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

    console.log(`Switched ${depName} to local: ${absLocalPath}`)

    if (options.install) {
      runPnpmInstall(projectRoot)
    }
  })

program
  .command('github [dep] [ref]')
  .aliases(['gh', 'g'])
  .description('Switch dependency to GitHub ref (defaults to dist branch HEAD)')
  .option('-g, --global', 'Install globally (uses global config)')
  .option('-s, --sha', 'Resolve ref to SHA')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((arg1: string | undefined, arg2: string | undefined, options: { global: boolean; sha: boolean; install: boolean }) => {
    const config = options.global ? loadGlobalConfig() : loadConfig(findProjectRoot())
    const deps = Object.entries(config.dependencies)

    // If only one arg and exactly one dep configured, treat arg as ref
    let depQuery: string | undefined
    let ref: string | undefined
    if (arg1 && !arg2 && deps.length === 1) {
      depQuery = undefined
      ref = arg1
    } else {
      depQuery = arg1
      ref = arg2
    }

    const [depName, depConfig] = findMatchingDep(config, depQuery)

    if (!depConfig.github) {
      throw new Error(`No GitHub repo configured for ${depName}. Use "pds init" with -G/--github`)
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

    const specifier = `github:${depConfig.github}#${resolvedRef}`

    if (options.global) {
      runGlobalInstall(specifier)
      console.log(`Installed ${depName} globally from GitHub: ${depConfig.github}#${resolvedRef}`)
      return
    }

    const projectRoot = findProjectRoot()

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

    console.log(`Switched ${depName} to GitHub: ${depConfig.github}#${resolvedRef}`)

    if (options.install) {
      runPnpmInstall(projectRoot)
    }
  })

program
  .command('gitlab [dep] [ref]')
  .aliases(['gl'])
  .description('Switch dependency to GitLab ref (defaults to dist branch HEAD)')
  .option('-g, --global', 'Install globally (uses global config)')
  .option('-s, --sha', 'Resolve ref to SHA')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((arg1: string | undefined, arg2: string | undefined, options: { global: boolean; sha: boolean; install: boolean }) => {
    const config = options.global ? loadGlobalConfig() : loadConfig(findProjectRoot())
    const deps = Object.entries(config.dependencies)

    // If only one arg and exactly one dep configured, treat arg as ref
    let depQuery: string | undefined
    let ref: string | undefined
    if (arg1 && !arg2 && deps.length === 1) {
      depQuery = undefined
      ref = arg1
    } else {
      depQuery = arg1
      ref = arg2
    }

    const [depName, depConfig] = findMatchingDep(config, depQuery)

    if (!depConfig.gitlab) {
      throw new Error(`No GitLab repo configured for ${depName}. Use "pds init" with -l/--gitlab`)
    }

    const distBranch = depConfig.distBranch ?? 'dist'

    let resolvedRef: string
    if (!ref) {
      // No ref provided: use dist branch, resolve to SHA
      resolvedRef = resolveGitLabRef(depConfig.gitlab, distBranch)
    } else if (options.sha) {
      // Ref provided with -s: resolve to SHA via GitLab API
      resolvedRef = resolveGitLabRef(depConfig.gitlab, ref)
    } else {
      // Ref provided without -s: use as-is
      resolvedRef = ref
    }

    // GitLab uses tarball URL format (pnpm doesn't support gitlab: prefix)
    // Format: https://gitlab.com/{repo}/-/archive/{ref}/{basename}-{ref}.tar.gz
    const repoBasename = depConfig.gitlab.split('/').pop()
    const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${resolvedRef}/${repoBasename}-${resolvedRef}.tar.gz`

    if (options.global) {
      runGlobalInstall(tarballUrl)
      console.log(`Installed ${depName} globally from GitLab: ${depConfig.gitlab}@${resolvedRef}`)
      return
    }

    const projectRoot = findProjectRoot()

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, tarballUrl)
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

    console.log(`Switched ${depName} to GitLab: ${depConfig.gitlab}@${resolvedRef}`)

    if (options.install) {
      runPnpmInstall(projectRoot)
    }
  })

program
  .command('npm [dep] [version]')
  .alias('n')
  .description('Switch dependency to NPM (defaults to latest)')
  .option('-g, --global', 'Install globally (uses global config)')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((arg1: string | undefined, arg2: string | undefined, options: { global: boolean; install: boolean }) => {
    const config = options.global ? loadGlobalConfig() : loadConfig(findProjectRoot())
    const deps = Object.entries(config.dependencies)

    // If only one arg and exactly one dep configured, treat arg as version
    let depQuery: string | undefined
    let version: string | undefined
    if (arg1 && !arg2 && deps.length === 1) {
      depQuery = undefined
      version = arg1
    } else {
      depQuery = arg1
      version = arg2
    }

    const [depName, depConfig] = findMatchingDep(config, depQuery)

    const npmName = depConfig.npm ?? depName
    // Resolve latest version from NPM if not specified
    const resolvedVersion = version ?? getLatestNpmVersion(npmName)
    const specifier = `${npmName}@${resolvedVersion}`

    if (options.global) {
      runGlobalInstall(specifier)
      console.log(`Installed ${depName} globally from NPM: ${specifier}`)
      return
    }

    const projectRoot = findProjectRoot()

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, `^${resolvedVersion}`)
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

    console.log(`Switched ${depName} to NPM: ^${resolvedVersion}`)

    if (options.install) {
      runPnpmInstall(projectRoot)
    }
  })

program
  .command('status [dep]')
  .alias('s')
  .description('Show current source for dependency (or all if none specified)')
  .option('-g, --global', 'Show status of global dependencies')
  .action((depQuery: string | undefined, options: { global?: boolean }) => {
    if (options.global) {
      const config = loadGlobalConfig()
      const deps = depQuery
        ? [findMatchingDep(config, depQuery)]
        : Object.entries(config.dependencies)

      for (const [name] of deps) {
        const installSource = getGlobalInstallSource(name)
        if (installSource) {
          console.log(`${name}: ${installSource.source} (${installSource.specifier})`)
        } else {
          console.log(`${name}: (not installed)`)
        }
      }
      return
    }

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
      else if (current.includes('gitlab.com') && current.includes('/-/archive/')) sourceType = 'gitlab'
      else if (current.match(/^\^?\d|^latest/)) sourceType = 'npm'

      console.log(`${name}: ${sourceType} (${current})`)
    }
  })

program
  .command('info')
  .alias('i')
  .description('Show pds version and install source')
  .action(() => {
    const binPath = process.argv[1]
    let realPath: string
    try {
      realPath = realpathSync(binPath)
    } catch {
      realPath = binPath
    }

    console.log(`pnpm-dep-source v${VERSION}`)
    if (binPath !== realPath) {
      console.log(`  binary: ${binPath} -> ${realPath}`)
    } else {
      console.log(`  binary: ${binPath}`)
    }

    // Determine source from the actual binary path first
    const pkgDir = realPath.includes('/dist/cli.js')
      ? realPath.replace(/\/dist\/cli\.js$/, '')
      : realPath.includes('/cli.js')
        ? realPath.replace(/\/cli\.js$/, '')
        : dirname(dirname(realPath)) // assume bin/pds structure

    const pkgJsonPath = join(pkgDir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
        const version = pkg.version || 'unknown'

        // Check if this looks like a development checkout (has src/, .git, etc.)
        const hasSrc = existsSync(join(pkgDir, 'src'))
        const hasGit = existsSync(join(pkgDir, '.git'))

        if (hasSrc && hasGit) {
          console.log(`  source: local development`)
          return
        }

        // Check if it's in pnpm global store
        if (realPath.includes('.pnpm')) {
          console.log(`  source: pnpm global (${version})`)
          return
        }

        // Check if it's in node_modules
        if (realPath.includes('node_modules')) {
          console.log(`  source: npm (${version})`)
          return
        }

        // Has package.json but not in node_modules or local dev
        console.log(`  source: ${version}`)
        return
      } catch {
        // Fall through
      }
    }

    // Fallback: try pnpm global list
    const installSource = getGlobalInstallSource()
    if (installSource) {
      console.log(`  source: ${installSource.source} (${installSource.specifier})`)
      return
    }

    console.log(`  source: unknown`)
  })

program.parse()
