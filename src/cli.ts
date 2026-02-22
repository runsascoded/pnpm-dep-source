#!/usr/bin/env node

import { program } from 'commander'
import { execSync, spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { parseModule } from 'magicast'
import { basename, dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Find package.json by walking up from current file
// (handles both dev mode where cli is in dist/, and dist branch where cli is at root)
function findOwnPackageJson(): string {
  let dir = __dirname
  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.name === 'pnpm-dep-source') return pkgPath
    }
    dir = dirname(dir)
  }
  throw new Error('Could not find pnpm-dep-source package.json')
}

const pkgJson = JSON.parse(readFileSync(findOwnPackageJson(), 'utf-8'))
const VERSION = pkgJson.version as string

const CONFIG_FILES = ['.pds.json', '.pnpm-dep-source.json']

function resolveConfigPath(projectRoot: string): string {
  for (const f of CONFIG_FILES) {
    const p = join(projectRoot, f)
    if (existsSync(p)) return p
  }
  return join(projectRoot, CONFIG_FILES[0])
}
const GLOBAL_CONFIG_DIR = join(homedir(), '.config', 'pnpm-dep-source')
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json')

function spawnAsync(
  cmd: string,
  args: string[],
  opts: { encoding: 'utf-8' },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.setEncoding(opts.encoding)
    child.stderr.setEncoding(opts.encoding)
    child.stdout.on('data', (d: string) => stdout.push(d))
    child.stderr.on('data', (d: string) => stderr.push(d))
    child.on('close', (status) => {
      resolve({ status, stdout: stdout.join(''), stderr: stderr.join('') })
    })
  })
}

interface DepConfig {
  localPath?: string    // optional when initialized from URL
  github?: string       // e.g. "runsascoded/use-kbd"
  gitlab?: string       // e.g. "runsascoded/js/screenshots"
  npm?: string          // e.g. "use-kbd" (defaults to package name from local)
  distBranch?: string   // defaults to "dist"
  subdir?: string       // e.g. "/packages/client" for monorepo subdirectory
}

interface Config {
  dependencies: Record<string, DepConfig>
  skipCheck?: boolean  // Deprecated: use checkOn: "none" instead
  checkOn?: "pre-push" | "pre-commit" | "none"
}

// Common subdirectories where JS projects might live
const JS_PROJECT_SUBDIRS = ['www', 'web', 'app', 'frontend', 'client', 'packages', 'src']

// Find project root (directory containing package.json)
function findProjectRoot(startDir: string = process.cwd()): string {
  let dir = startDir
  let foundGit = false
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) foundGit = true
    if (existsSync(join(dir, 'package.json'))) {
      return dir
    }
    const parent = dirname(dir)
    // Don't walk past git repo boundary into a parent git repo
    if (foundGit && parent !== dir && existsSync(join(parent, '.git'))) break
    dir = parent
  }

  // No package.json found - look for JS projects in subdirectories and provide helpful error
  const cwd = process.cwd()
  const suggestions: string[] = []

  for (const subdir of JS_PROJECT_SUBDIRS) {
    const subdirPath = join(cwd, subdir)
    if (existsSync(join(subdirPath, 'package.json'))) {
      suggestions.push(subdir)
    }
  }

  // Also check for any immediate subdirectory with package.json
  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !suggestions.includes(entry.name)) {
        if (existsSync(join(cwd, entry.name, 'package.json'))) {
          suggestions.push(entry.name)
        }
      }
    }
  } catch {
    // Ignore errors reading directory
  }

  let message = 'No package.json found in current directory or any parent.'
  if (suggestions.length > 0) {
    message += `\n\nFound JS projects in subdirectories:\n${suggestions.map(s => `  cd ${s}`).join('\n')}`
  }

  throw new Error(message)
}

// Find workspace root (ancestor directory with pnpm-workspace.yaml above projectRoot)
function findWorkspaceRoot(projectRoot: string): string | null {
  let dir = dirname(projectRoot)
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = dirname(dir)
  }
  return null
}

// Compute the path to put in pnpm-workspace.yaml for a dep's localPath
function workspaceLocalPath(projectRoot: string, localPath: string, workspaceRoot?: string | null): string {
  const wsRoot = workspaceRoot ?? projectRoot
  return relative(wsRoot, resolve(projectRoot, localPath))
}

function loadConfig(projectRoot: string): Config {
  const configPath = resolveConfigPath(projectRoot)
  if (!existsSync(configPath)) {
    return { dependencies: {} }
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

function saveConfig(projectRoot: string, config: Config): void {
  const configPath = resolveConfigPath(projectRoot)
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
  let existingContent = ''

  if (existsSync(wsPath)) {
    existingContent = readFileSync(wsPath, 'utf-8')
  }

  // Remove existing packages section from content
  const lines = existingContent.split('\n')
  const filteredLines: string[] = []
  let inPackages = false

  for (const line of lines) {
    if (line.match(/^packages:\s*$/)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      // Skip package list items (indented with -)
      if (line.match(/^\s+-/)) {
        continue
      }
      // Non-indented non-empty line ends packages section
      if (!line.match(/^\s/) && line.trim()) {
        inPackages = false
        filteredLines.push(line)
      }
      // Skip empty/whitespace lines within packages section
      continue
    }
    filteredLines.push(line)
  }

  // Build new content
  let newContent = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  // Add packages section if we have packages
  if (config?.packages && config.packages.length > 0) {
    const packagesSection = 'packages:\n' + config.packages.map(p => `  - ${p}`).join('\n')
    if (newContent) {
      newContent = newContent + '\n\n' + packagesSection + '\n'
    } else {
      newContent = packagesSection + '\n'
    }
    writeFileSync(wsPath, newContent)
  } else if (newContent) {
    // No packages but other content exists - keep the file without packages section
    writeFileSync(wsPath, newContent + '\n')
  } else if (existsSync(wsPath)) {
    // No packages and no other content - remove the file
    execSync(`rm "${wsPath}"`)
  }
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

  const queryLower = query.toLowerCase()

  // First, check for exact match (case-insensitive)
  const exactMatch = deps.find(([name]) => name.toLowerCase() === queryLower)
  if (exactMatch) {
    return exactMatch
  }

  // Fall back to substring matching
  const matches = deps.filter(([name]) =>
    name.toLowerCase().includes(queryLower)
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

function hasDependency(pkg: Record<string, unknown>, depName: string): boolean {
  const deps = pkg.dependencies as Record<string, string> | undefined
  const devDeps = pkg.devDependencies as Record<string, string> | undefined
  return (deps && depName in deps) || (devDeps && depName in devDeps) || false
}

function addDependency(
  pkg: Record<string, unknown>,
  depName: string,
  specifier: string,
  isDev: boolean,
): void {
  const key = isDev ? 'devDependencies' : 'dependencies'
  if (!pkg[key]) {
    pkg[key] = {}
  }
  const deps = pkg[key] as Record<string, string>
  deps[depName] = specifier
}

function getCurrentSource(pkg: Record<string, unknown>, depName: string): string {
  const deps = pkg.dependencies as Record<string, string> | undefined
  const devDeps = pkg.devDependencies as Record<string, string> | undefined
  return deps?.[depName] ?? devDeps?.[depName] ?? '(not found)'
}

function getInstalledVersion(projectRoot: string, depName: string): string | null {
  const pkgPath = join(projectRoot, 'node_modules', depName, 'package.json')
  if (!existsSync(pkgPath)) {
    return null
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version ?? null
  } catch {
    return null
  }
}

function getLocalGitInfo(localPath: string): { sha: string; dirty: boolean } | null {
  if (!existsSync(localPath)) {
    return null
  }
  try {
    // Get short SHA
    const shaResult = spawnSync('git', ['-C', localPath, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    })
    if (shaResult.status !== 0) {
      return null
    }
    const sha = shaResult.stdout.trim()

    // Check if dirty
    const statusResult = spawnSync('git', ['-C', localPath, 'status', '--porcelain'], {
      encoding: 'utf-8',
    })
    const dirty = statusResult.status === 0 && statusResult.stdout.trim().length > 0

    return { sha, dirty }
  } catch {
    return null
  }
}

async function getLocalGitInfoAsync(localPath: string): Promise<{ sha: string; dirty: boolean } | null> {
  if (!existsSync(localPath)) {
    return null
  }
  try {
    const [shaResult, statusResult] = await Promise.all([
      spawnAsync('git', ['-C', localPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }),
      spawnAsync('git', ['-C', localPath, 'status', '--porcelain'], { encoding: 'utf-8' }),
    ])
    if (shaResult.status !== 0) {
      return null
    }
    const sha = shaResult.stdout.trim()
    const dirty = statusResult.status === 0 && statusResult.stdout.trim().length > 0
    return { sha, dirty }
  } catch {
    return null
  }
}

// ANSI color codes (only used when stdout is TTY)
const isTTY = process.stdout.isTTY
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  red: isTTY ? '\x1b[31m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
}

function formatGitInfo(info: { sha: string; dirty: boolean } | null): string {
  if (!info) return ''
  const dirtyStr = info.dirty ? ` ${c.red}dirty${c.reset}` : ''
  return ` ${c.blue}(${info.sha}${dirtyStr}${c.blue})${c.reset}`
}

// Unified display info for a dependency
interface DepDisplayInfo {
  name: string
  currentSource: string        // e.g. "workspace:*", "github:user/repo#sha", or "local"
  currentSpecifier?: string    // For global mode: the path or version
  sourceType: 'local' | 'github' | 'gitlab' | 'npm' | 'unknown'
  isDev?: boolean              // Whether it's a devDependency
  isGlobal?: boolean           // Whether it's a global dependency
  version?: string             // Installed version from node_modules
  gitInfo?: { sha: string; dirty: boolean } | null
  config: DepConfig
}

function getSourceType(source: string): 'local' | 'github' | 'gitlab' | 'npm' | 'unknown' {
  if (source === 'workspace:*' || source === 'local') return 'local'
  if (source.startsWith('github:') || source.includes('github.com/')) return 'github'
  if (source.includes('gitlab.com') && source.includes('/-/archive/')) return 'gitlab'
  if (source.match(/^\^?\d|^latest/)) return 'npm'
  return 'unknown'
}

type RemoteVersions = {
  npm?: string
  github?: string; githubVersion?: string
  gitlab?: string; gitlabVersion?: string
}

// Build blue-colored parenthesized suffix showing current ref/version for the active line
function formatActiveSuffix(info: DepDisplayInfo): string {
  if (info.sourceType === 'local') return ''

  const parts: string[] = []

  if (info.isGlobal && info.currentSpecifier) {
    parts.push(info.currentSpecifier)
  } else {
    if (info.sourceType === 'github') {
      const match = info.currentSource.match(/#([a-f0-9]+)$/)
      if (match) parts.push(match[1].slice(0, 7))
    } else if (info.sourceType === 'gitlab') {
      const match = info.currentSource.match(/\/-\/archive\/([^/]+)\//)
      if (match) parts.push(match[1].slice(0, 7))
    }
    if (info.version) parts.push(info.version)
  }

  if (parts.length === 0) return ''
  return ` ${c.blue}(${parts.join('; ')})${c.reset}`
}

function displayDep(
  info: DepDisplayInfo,
  verbose: boolean = false,
  remoteVersions?: RemoteVersions,
): void {
  const tag = info.isGlobal ? ` ${c.yellow}[global]${c.reset}`
    : info.isDev ? ` ${c.yellow}[dev]${c.reset}`
    : ''
  console.log(`${c.bold}${c.cyan}${info.name}${c.reset}${tag}:`)

  const active = info.sourceType
  const versions = verbose ? (remoteVersions ?? fetchRemoteVersions(info.config, info.name)) : undefined

  function line(label: string, isActive: boolean, value: string, suffix: string = ''): void {
    const prefix = isActive ? `${c.green}*${c.reset} ` : '  '
    const coloredLabel = isActive ? `${c.green}${label}${c.reset}` : label
    console.log(`${prefix}${coloredLabel}: ${value}${suffix}`)
  }

  if (info.config.localPath) {
    const gitSuffix = info.gitInfo ? formatGitInfo(info.gitInfo) : ''
    line('Local', active === 'local', info.config.localPath, gitSuffix)
  }
  if (info.config.github) {
    const isActive = active === 'github'
    const activeSuffix = isActive ? formatActiveSuffix(info) : ''
    const distParts = [versions?.github, versions?.githubVersion].filter(Boolean)
    const subdirSuffix = info.config.subdir ? ` ${c.cyan}[${info.config.subdir}]${c.reset}` : ''
    if (isActive && distParts.length && !distParts.every(p => activeSuffix.includes(p as string))) {
      line('GitHub', true, info.config.github + subdirSuffix, activeSuffix)
      console.log(`      ${c.blue}dist@${distParts.join('; ')}${c.reset}`)
    } else {
      const distSuffix = !isActive && distParts.length ? ` ${c.blue}(dist@${distParts.join('; ')})${c.reset}` : ''
      line('GitHub', isActive, info.config.github + subdirSuffix, activeSuffix + distSuffix)
    }
  }
  if (info.config.gitlab) {
    const isActive = active === 'gitlab'
    const activeSuffix = isActive ? formatActiveSuffix(info) : ''
    const distParts = [versions?.gitlab, versions?.gitlabVersion].filter(Boolean)
    if (isActive && distParts.length && !distParts.every(p => activeSuffix.includes(p as string))) {
      line('GitLab', true, info.config.gitlab, activeSuffix)
      console.log(`      ${c.blue}dist@${distParts.join('; ')}${c.reset}`)
    } else {
      const distSuffix = !isActive && distParts.length ? ` ${c.blue}(dist@${distParts.join('; ')})${c.reset}` : ''
      line('GitLab', isActive, info.config.gitlab, activeSuffix + distSuffix)
    }
  }
  if (info.config.npm) {
    const isActive = active === 'npm'
    // In verbose mode, omit NPM line if no published version exists and npm isn't the active source
    if (verbose && !isActive && !versions?.npm) return
    const activeSuffix = isActive ? formatActiveSuffix(info) : ''
    const latestSuffix = versions?.npm ? ` ${c.blue}(latest: ${versions.npm})${c.reset}` : ''
    line('NPM', isActive, info.config.npm, activeSuffix + latestSuffix)
  }
}

function buildGlobalDepInfo(name: string, dep: DepConfig): DepDisplayInfo {
  const installSource = getGlobalInstallSource(name)
  const sourceType: DepDisplayInfo['sourceType'] = (installSource?.source as DepDisplayInfo['sourceType']) ?? 'unknown'
  const gitInfo = dep.localPath ? getLocalGitInfo(dep.localPath) : null

  return {
    name,
    currentSource: installSource?.source ?? '(not installed)',
    currentSpecifier: installSource?.specifier,
    sourceType,
    isGlobal: true,
    gitInfo,
    config: dep,
  }
}

function buildProjectDepInfo(
  name: string,
  dep: DepConfig,
  projectRoot: string,
  pkg: Record<string, unknown>,
): DepDisplayInfo {
  const currentSource = getCurrentSource(pkg, name)
  const sourceType = getSourceType(currentSource)
  const devDeps = pkg.devDependencies as Record<string, string> | undefined
  const isDev = !!(devDeps && name in devDeps)

  const version = sourceType !== 'local' ? (getInstalledVersion(projectRoot, name) ?? undefined) : undefined
  const gitInfo = dep.localPath ? getLocalGitInfo(resolve(projectRoot, dep.localPath)) : null

  return {
    name,
    currentSource,
    sourceType,
    isDev,
    version,
    gitInfo,
    config: dep,
  }
}

async function buildGlobalDepInfoAsync(
  name: string,
  dep: DepConfig,
  globalSources: Map<string, { source: string; specifier: string }>,
): Promise<DepDisplayInfo> {
  const installSource = globalSources.get(name) ?? null
  const sourceType: DepDisplayInfo['sourceType'] = (installSource?.source as DepDisplayInfo['sourceType']) ?? 'unknown'
  const gitInfo = dep.localPath ? await getLocalGitInfoAsync(dep.localPath) : null

  return {
    name,
    currentSource: installSource?.source ?? '(not installed)',
    currentSpecifier: installSource?.specifier,
    sourceType,
    isGlobal: true,
    gitInfo,
    config: dep,
  }
}

async function buildProjectDepInfoAsync(
  name: string,
  dep: DepConfig,
  projectRoot: string,
  pkg: Record<string, unknown>,
): Promise<DepDisplayInfo> {
  const currentSource = getCurrentSource(pkg, name)
  const sourceType = getSourceType(currentSource)
  const devDeps = pkg.devDependencies as Record<string, string> | undefined
  const isDev = !!(devDeps && name in devDeps)

  const version = sourceType !== 'local' ? (getInstalledVersion(projectRoot, name) ?? undefined) : undefined
  const gitInfo = dep.localPath ? await getLocalGitInfoAsync(resolve(projectRoot, dep.localPath)) : null

  return {
    name,
    currentSource,
    sourceType,
    isDev,
    version,
    gitInfo,
    config: dep,
  }
}

async function fetchRemoteVersionsAsync(
  dep: DepConfig,
  depName: string,
): Promise<RemoteVersions> {
  const distBranch = dep.distBranch ?? 'dist'
  const npmName = dep.npm ?? depName

  const [npmVersion, ghSha, ghPkg, glSha, glPkg] = await Promise.all([
    getLatestNpmVersionAsync(npmName).catch(() => undefined),
    dep.github ? resolveGitHubRefAsync(dep.github, distBranch).catch(() => undefined) : undefined,
    dep.github ? fetchGitHubPackageJsonAsync(dep.github, distBranch).catch(() => undefined) : undefined,
    dep.gitlab ? resolveGitLabRefAsync(dep.gitlab, distBranch).catch(() => undefined) : undefined,
    dep.gitlab ? fetchGitLabPackageJsonAsync(dep.gitlab, distBranch).catch(() => undefined) : undefined,
  ])

  return {
    npm: npmVersion,
    github: ghSha ? ghSha.slice(0, 7) : undefined,
    githubVersion: ghPkg?.version as string | undefined,
    gitlab: glSha ? glSha.slice(0, 7) : undefined,
    gitlabVersion: glPkg?.version as string | undefined,
  }
}

function updateViteConfig(projectRoot: string, depName: string, exclude: boolean): void {
  const vitePath = join(projectRoot, 'vite.config.ts')
  if (!existsSync(vitePath)) {
    return
  }

  const content = readFileSync(vitePath, 'utf-8')
  let mod
  try {
    mod = parseModule(content)
  } catch {
    return
  }

  // Handle both `export default defineConfig({...})` and `export default {...}`
  const raw = mod.exports.default
  const config = raw?.$args ? raw.$args[0] : raw
  if (!config) return

  if (exclude) {
    if (!config.optimizeDeps) config.optimizeDeps = {}
    if (!config.optimizeDeps.exclude) config.optimizeDeps.exclude = []
    if (!config.optimizeDeps.exclude.includes(depName)) {
      config.optimizeDeps.exclude.push(depName)
    }
  } else {
    if (config.optimizeDeps?.exclude) {
      config.optimizeDeps.exclude = config.optimizeDeps.exclude.filter((x: string) => x !== depName)
      if (config.optimizeDeps.exclude.length === 0) {
        delete config.optimizeDeps.exclude
      }
    }
    if (config.optimizeDeps && Object.keys(config.optimizeDeps).length === 0) {
      delete config.optimizeDeps
    }
  }

  let code = mod.generate().code
  if (content.endsWith('\n') && !code.endsWith('\n')) {
    code += '\n'
  }
  writeFileSync(vitePath, code)
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

async function resolveGitHubRefAsync(repo: string, ref: string): Promise<string> {
  const result = await spawnAsync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], { encoding: 'utf-8' })
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

async function resolveGitLabRefAsync(repo: string, ref: string): Promise<string> {
  const encodedRepo = encodeURIComponent(repo)
  const result = await spawnAsync('glab', ['api', `projects/${encodedRepo}/repository/commits/${ref}`], { encoding: 'utf-8' })
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

interface PackageInfo {
  name: string
  github?: string  // "user/repo" format
  gitlab?: string  // "group/subgroup/repo" format
}

// Parse GitHub/GitLab repo from a URL string
function parseRepoUrl(repoUrl: string): { github?: string; gitlab?: string } {
  const result: { github?: string; gitlab?: string } = {}

  // Handle various URL formats:
  // - git+https://github.com/user/repo.git
  // - https://github.com/user/repo
  // - github:user/repo
  // - git@github.com:user/repo.git
  const githubMatch = repoUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
    || repoUrl.match(/^github:([\w.-]+\/[\w.-]+)$/)
  if (githubMatch) {
    result.github = githubMatch[1]
  }

  // GitLab supports nested groups: gitlab.com/group/subgroup/repo
  const gitlabMatch = repoUrl.match(/gitlab\.com[/:]([\w./-]+?)(?:\.git)?$/)
    || repoUrl.match(/^gitlab:([\w./-]+)$/)
  if (gitlabMatch) {
    result.gitlab = gitlabMatch[1]
  }

  return result
}

// Parse package.json content into PackageInfo
function parsePackageJson(pkg: Record<string, unknown>): PackageInfo {
  const result: PackageInfo = { name: pkg.name as string }

  const repo = pkg.repository
  if (repo) {
    let repoUrl: string | undefined
    if (typeof repo === 'string') {
      repoUrl = repo
    } else if (typeof repo === 'object' && repo !== null && 'url' in repo) {
      repoUrl = (repo as { url: string }).url
    }

    if (repoUrl) {
      const parsed = parseRepoUrl(repoUrl)
      result.github = parsed.github
      result.gitlab = parsed.gitlab
    }
  }

  return result
}

// Fetch package.json from GitHub repo
function fetchGitHubPackageJson(repo: string, ref = 'HEAD'): Record<string, unknown> {
  const result = spawnSync('gh', ['api', `repos/${repo}/contents/package.json`, '--jq', '.content'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to fetch package.json from GitHub ${repo}: ${result.stderr}`)
  }
  const content = Buffer.from(result.stdout.trim(), 'base64').toString('utf-8')
  return JSON.parse(content)
}

// Fetch package.json from GitLab repo
function fetchGitLabPackageJson(repo: string, ref = 'HEAD'): Record<string, unknown> {
  const encodedPath = encodeURIComponent(repo)
  const result = spawnSync('glab', ['api', `projects/${encodedPath}/repository/files/package.json/raw?ref=${ref}`], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to fetch package.json from GitLab ${repo}: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

async function fetchGitHubPackageJsonAsync(repo: string, ref = 'HEAD'): Promise<Record<string, unknown>> {
  const result = await spawnAsync('gh', ['api', `repos/${repo}/contents/package.json?ref=${ref}`, '--jq', '.content'], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`Failed to fetch package.json from GitHub ${repo}: ${result.stderr}`)
  }
  const content = Buffer.from(result.stdout.trim(), 'base64').toString('utf-8')
  return JSON.parse(content)
}

async function fetchGitLabPackageJsonAsync(repo: string, ref = 'HEAD'): Promise<Record<string, unknown>> {
  const encodedPath = encodeURIComponent(repo)
  const result = await spawnAsync('glab', ['api', `projects/${encodedPath}/repository/files/package.json/raw?ref=${ref}`], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`Failed to fetch package.json from GitLab ${repo}: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

// Detect GitHub/GitLab repo from git remote in or above the given path
// Also returns subdir if startPath is inside a subdirectory of the repo
function detectGitRepo(startPath: string): { github?: string; gitlab?: string; subdir?: string } | null {
  let dir = startPath
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      // Found git repo, get remote URLs
      const result = spawnSync('git', ['-C', dir, 'remote', '-v'], {
        encoding: 'utf-8',
      })
      if (result.status !== 0) {
        return null
      }

      // Calculate subdir relative to git root
      const relPath = relative(dir, startPath)
      const subdir = relPath ? `/${relPath}` : undefined

      // Parse remote URLs - take the first fetch URL that matches GitHub/GitLab
      for (const line of result.stdout.split('\n')) {
        const match = line.match(/^\S+\s+(\S+)\s+\(fetch\)$/)
        if (match) {
          const parsed = parseRepoUrl(match[1])
          if (parsed.github || parsed.gitlab) {
            return { ...parsed, subdir }
          }
        }
      }
      return null
    }
    dir = dirname(dir)
  }
  return null
}

// Get package info from local path
function getLocalPackageInfo(localPath: string): PackageInfo & { subdir?: string } {
  const pkgPath = join(localPath, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json found at ${localPath}`)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const info = parsePackageJson(pkg)

  // Detect git repo and subdir
  const gitRepo = detectGitRepo(localPath)
  if (gitRepo) {
    // Fallback to git remote detection if no repo found in package.json
    if (!info.github && !info.gitlab) {
      info.github = gitRepo.github
      info.gitlab = gitRepo.gitlab
    }
    // Always capture subdir for monorepo support
    return { ...info, subdir: gitRepo.subdir }
  }

  return info
}

// Get package info from URL (GitHub or GitLab)
function getRemotePackageInfo(url: string): PackageInfo & { github?: string; gitlab?: string } {
  const parsed = parseRepoUrl(url)

  let pkg: Record<string, unknown>
  if (parsed.github) {
    pkg = fetchGitHubPackageJson(parsed.github)
  } else if (parsed.gitlab) {
    pkg = fetchGitLabPackageJson(parsed.gitlab)
  } else {
    throw new Error(`Cannot parse repository from URL: ${url}`)
  }

  const info = parsePackageJson(pkg)
  // Override with the URL we were given (it's authoritative)
  return {
    ...info,
    github: parsed.github ?? info.github,
    gitlab: parsed.gitlab ?? info.gitlab,
  }
}

// Check if argument looks like a URL rather than a local path
function isRepoUrl(arg: string): boolean {
  return arg.startsWith('http://') ||
    arg.startsWith('https://') ||
    arg.startsWith('github:') ||
    arg.startsWith('gitlab:') ||
    arg.startsWith('git@')
}

function getLocalPackageName(localPath: string): string {
  return getLocalPackageInfo(localPath).name
}

function runPnpmInstall(projectRoot: string, workspaceRoot?: string | null): void {
  const installDir = workspaceRoot ?? projectRoot
  console.log('Running pnpm install...')
  try {
    execSync('pnpm install', { cwd: installDir, stdio: 'inherit' })
  } catch {
    console.error(`${c.yellow}Warning: pnpm install failed (config changes were saved)${c.reset}`)
  }
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

async function getLatestNpmVersionAsync(packageName: string): Promise<string> {
  const result = await spawnAsync('npm', ['view', packageName, 'version'], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`Failed to get latest version for ${packageName}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

// Cache for global install sources (fetched once via pnpm list -g --json)
let globalInstallCache: Map<string, { source: string; specifier: string }> | null = null

function parseGlobalPkgSource(
  pkg: { version?: string; resolved?: string; path?: string },
  globalDir: string,
): { source: string; specifier: string } | null {
  const version = pkg.version || ''
  const resolved = pkg.resolved || ''
  const pkgPath = pkg.path || ''

  // Local file install: version is "file:..." path
  if (version.startsWith('file:')) {
    const filePath = version.slice(5)
    const absPath = globalDir ? resolve(globalDir, filePath) : filePath
    return { source: 'local', specifier: absPath }
  }

  // Check resolved URL and install path for source detection
  const resolvedOrPath = resolved || pkgPath
  if (resolvedOrPath.includes('codeload.github.com') || resolvedOrPath.includes('github.com')) {
    const shaMatch = resolvedOrPath.match(/([a-f0-9]{40})/)
    const sha = shaMatch ? shaMatch[1].slice(0, 7) : ''
    return { source: 'github', specifier: `${sha}; ${version}` }
  } else if (resolvedOrPath.includes('gitlab.com') && (resolved.includes('/-/archive/') || pkgPath.includes('gitlab.com'))) {
    const refMatch = resolvedOrPath.match(/\/-\/archive\/([^/]+)\//) ?? resolvedOrPath.match(/([a-f0-9]{40})/)
    const ref = refMatch ? refMatch[1].slice(0, 7) : ''
    return { source: 'gitlab', specifier: `${ref}; ${version}` }
  } else if (version) {
    return { source: 'npm', specifier: version }
  }
  return null
}

function fetchAllGlobalInstallSources(): Map<string, { source: string; specifier: string }> {
  if (globalInstallCache) return globalInstallCache

  globalInstallCache = new Map()
  const result = spawnSync('pnpm', ['list', '-g', '--json'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) return globalInstallCache

  try {
    const data = JSON.parse(result.stdout)
    const globalDir = data[0]?.path || ''
    const deps = data[0]?.dependencies ?? {}
    for (const [name, pkg] of Object.entries(deps)) {
      const source = parseGlobalPkgSource(pkg as { version?: string; resolved?: string; path?: string }, globalDir)
      if (source) {
        globalInstallCache.set(name, source)
      }
    }
  } catch {
    // Ignore parse errors
  }
  return globalInstallCache
}

async function fetchAllGlobalInstallSourcesAsync(): Promise<Map<string, { source: string; specifier: string }>> {
  const map = new Map<string, { source: string; specifier: string }>()
  const result = await spawnAsync('pnpm', ['list', '-g', '--json'], { encoding: 'utf-8' })
  if (result.status !== 0) return map
  try {
    const data = JSON.parse(result.stdout)
    const globalDir = data[0]?.path || ''
    const deps = data[0]?.dependencies ?? {}
    for (const [name, pkg] of Object.entries(deps)) {
      const source = parseGlobalPkgSource(pkg as { version?: string; resolved?: string; path?: string }, globalDir)
      if (source) {
        map.set(name, source)
      }
    }
  } catch {
    // Ignore parse errors
  }
  return map
}

function getGlobalInstallSource(packageName = 'pnpm-dep-source'): { source: string; specifier: string } | null {
  return fetchAllGlobalInstallSources().get(packageName) ?? null
}

// Helper to switch a dependency to local mode
function switchToLocal(
  projectRoot: string,
  depName: string,
  localPath: string,
  workspaceRoot?: string | null,
): void {
  const pkg = loadPackageJson(projectRoot)
  updatePackageJsonDep(pkg, depName, 'workspace:*')
  savePackageJson(projectRoot, pkg)

  // Update pnpm-workspace.yaml
  const wsRoot = workspaceRoot ?? projectRoot
  const ws = loadWorkspaceYaml(wsRoot) ?? { packages: workspaceRoot ? [] : ['.'] }
  if (!ws.packages) ws.packages = workspaceRoot ? [] : ['.']
  if (!workspaceRoot && !ws.packages.includes('.')) ws.packages.unshift('.')
  const wsLocalPath = workspaceLocalPath(projectRoot, localPath, workspaceRoot)
  if (!ws.packages.includes(wsLocalPath)) {
    ws.packages.push(wsLocalPath)
  }
  saveWorkspaceYaml(wsRoot, ws)

  // Update vite.config.ts
  updateViteConfig(projectRoot, depName, true)

  console.log(`Switched ${depName} to local: ${resolve(projectRoot, localPath)}`)
}

// Generate GitHub specifier using HTTPS tarball URL (avoids SSH auth issues in CI)
function makeGitHubSpecifier(repo: string, ref: string, subdir?: string): string {
  if (subdir) {
    // pnpm git subdirectory syntax: #ref&path:/subdir
    return `https://github.com/${repo}#${ref}&path:${subdir}`
  }
  return `https://github.com/${repo}#${ref}`
}

// Helper to switch a dependency to GitHub mode
function switchToGitHub(
  projectRoot: string,
  depName: string,
  depConfig: DepConfig,
  ref?: string,
  workspaceRoot?: string | null,
): void {
  if (!depConfig.github) {
    throw new Error(`No GitHub repo configured for ${depName}`)
  }

  const distBranch = depConfig.distBranch ?? 'dist'
  const resolvedRef = ref ?? resolveGitHubRef(depConfig.github, distBranch)
  const specifier = makeGitHubSpecifier(depConfig.github, resolvedRef, depConfig.subdir)

  const pkg = loadPackageJson(projectRoot)
  updatePackageJsonDep(pkg, depName, specifier)
  removePnpmOverride(pkg, depName)
  savePackageJson(projectRoot, pkg)

  // Remove from pnpm-workspace.yaml
  if (depConfig.localPath) {
    const wsRoot = workspaceRoot ?? projectRoot
    const ws = loadWorkspaceYaml(wsRoot)
    if (ws?.packages) {
      const wsLocalPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot)
      ws.packages = ws.packages.filter(p => p !== wsLocalPath)
      if (workspaceRoot) {
        saveWorkspaceYaml(wsRoot, ws)
      } else if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
        saveWorkspaceYaml(wsRoot, null)
      } else {
        saveWorkspaceYaml(wsRoot, ws)
      }
    }
  }

  // Remove from vite.config.ts optimizeDeps.exclude
  updateViteConfig(projectRoot, depName, false)

  console.log(`Switched ${depName} to GitHub: ${specifier}`)
}

// Helper to switch a dependency to GitLab mode
function switchToGitLab(
  projectRoot: string,
  depName: string,
  depConfig: DepConfig,
  ref?: string,
  workspaceRoot?: string | null,
): void {
  if (!depConfig.gitlab) {
    throw new Error(`No GitLab repo configured for ${depName}`)
  }

  const distBranch = depConfig.distBranch ?? 'dist'
  const resolvedRef = ref ?? resolveGitLabRef(depConfig.gitlab, distBranch)

  // GitLab uses tarball URL format (pnpm doesn't support gitlab: prefix)
  const repoBasename = depConfig.gitlab.split('/').pop()
  const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${resolvedRef}/${repoBasename}-${resolvedRef}.tar.gz`

  const pkg = loadPackageJson(projectRoot)
  updatePackageJsonDep(pkg, depName, tarballUrl)
  removePnpmOverride(pkg, depName)
  savePackageJson(projectRoot, pkg)

  // Remove from pnpm-workspace.yaml
  if (depConfig.localPath) {
    const wsRoot = workspaceRoot ?? projectRoot
    const ws = loadWorkspaceYaml(wsRoot)
    if (ws?.packages) {
      const wsLocalPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot)
      ws.packages = ws.packages.filter(p => p !== wsLocalPath)
      if (workspaceRoot) {
        saveWorkspaceYaml(wsRoot, ws)
      } else if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
        saveWorkspaceYaml(wsRoot, null)
      } else {
        saveWorkspaceYaml(wsRoot, ws)
      }
    }
  }

  // Remove from vite.config.ts optimizeDeps.exclude
  updateViteConfig(projectRoot, depName, false)

  console.log(`Switched ${depName} to GitLab: ${depConfig.gitlab}@${resolvedRef}`)
}

program
  .name('pnpm-dep-source')
  .description('Switch pnpm dependencies between local, GitHub, and NPM sources')
  .version(VERSION)
  .option('-g, --global', 'Use global config (~/.config/pnpm-dep-source/) for CLI tools')

program
  .command('init [path-or-url]')
  .description('Initialize a dependency from local path or repo URL and activate it')
  .option('-b, --dist-branch <branch>', 'Git branch for dist builds', 'dist')
  .option('-D, --dev', 'Add as devDependency (if adding to package.json)')
  .option('-f, --force', 'Suppress mismatch warnings')
  .option('-H, --github <repo>', 'GitHub repo (e.g. "user/repo")')
  .option('-I, --no-install', 'Skip running pnpm install')
  .option('-L, --gitlab <repo>', 'GitLab repo (e.g. "user/repo")')
  .option('-l, --local <path>', 'Local path (when initializing from URL)')
  .option('-n, --npm <name>', 'NPM package name (defaults to name from package.json)')
  .action((pathOrUrl: string | undefined, options: { dev?: boolean; distBranch: string; force?: boolean; github?: string; gitlab?: string; install: boolean; local?: string; npm?: string }, cmd: { help: () => void }) => {
    if (!pathOrUrl) {
      cmd.help()
      return
    }
    const isGlobal = program.opts().global
    const isUrl = isRepoUrl(pathOrUrl)
    let pkgInfo: PackageInfo
    let localPath: string | undefined
    let activateSource: 'local' | 'github' | 'gitlab' | undefined

    if (isUrl) {
      // Fetch package.json from remote repo
      pkgInfo = getRemotePackageInfo(pathOrUrl)
      localPath = options.local ? resolve(options.local) : undefined
      // Determine which source to activate based on URL type
      if (localPath) {
        activateSource = 'local'
      } else if (pkgInfo.github) {
        activateSource = 'github'
      } else if (pkgInfo.gitlab) {
        activateSource = 'gitlab'
      }
    } else {
      // Read from local path
      localPath = resolve(pathOrUrl)
      pkgInfo = getLocalPackageInfo(localPath)
      activateSource = 'local'
    }

    const pkgName = pkgInfo.name

    // Warn on mismatches (unless --force)
    if (!options.force) {
      if (options.github && pkgInfo.github && options.github !== pkgInfo.github) {
        console.warn(`Warning: GitHub '${options.github}' differs from package.json '${pkgInfo.github}'`)
      }
      if (options.gitlab && pkgInfo.gitlab && options.gitlab !== pkgInfo.gitlab) {
        console.warn(`Warning: GitLab '${options.gitlab}' differs from package.json '${pkgInfo.gitlab}'`)
      }
      if (options.npm && options.npm !== pkgName) {
        console.warn(`Warning: NPM name '${options.npm}' differs from package.json '${pkgName}'`)
      }
    }

    const npmName = options.npm ?? pkgName
    const github = options.github ?? pkgInfo.github
    const gitlab = options.gitlab ?? pkgInfo.gitlab
    const subdir = 'subdir' in pkgInfo ? (pkgInfo as { subdir?: string }).subdir : undefined

    if (isGlobal) {
      const config = loadGlobalConfig()
      config.dependencies[pkgName] = {
        localPath,
        github,
        gitlab,
        npm: npmName,
        distBranch: options.distBranch,
        subdir,
      }
      saveGlobalConfig(config)
      console.log(`Initialized ${pkgName} (global):`)
      if (localPath) console.log(`  Local path: ${localPath}`)
      if (github) console.log(`  GitHub: ${github}`)
      if (gitlab) console.log(`  GitLab: ${gitlab}`)
      if (subdir) console.log(`  Subdir: ${subdir}`)
      console.log(`  NPM: ${npmName}`)
      console.log(`  Dist branch: ${options.distBranch}`)

      // Activate for global: install from local path if provided
      if (localPath) {
        runGlobalInstall(`file:${localPath}`)
        console.log(`Installed ${pkgName} globally from local: ${localPath}`)
      }
      return
    }

    const projectRoot = findProjectRoot()
    const workspaceRoot = findWorkspaceRoot(projectRoot)
    const config = loadConfig(projectRoot)
    const relLocalPath = localPath ? relative(projectRoot, localPath) : undefined

    const depConfig: DepConfig = {
      localPath: relLocalPath,
      github,
      gitlab,
      npm: npmName,
      distBranch: options.distBranch,
      subdir,
    }
    config.dependencies[pkgName] = depConfig

    saveConfig(projectRoot, config)
    console.log(`Initialized ${pkgName}:`)
    if (relLocalPath) console.log(`  Local path: ${relLocalPath}`)
    if (github) console.log(`  GitHub: ${github}`)
    if (gitlab) console.log(`  GitLab: ${gitlab}`)
    if (subdir) console.log(`  Subdir: ${subdir}`)
    console.log(`  NPM: ${npmName}`)
    console.log(`  Dist branch: ${options.distBranch}`)

    // Activate the dependency based on input type
    // If dep not in package.json, add it first
    const pkg = loadPackageJson(projectRoot)
    const needsAdd = !hasDependency(pkg, pkgName)

    if (needsAdd) {
      // Add a placeholder that will be replaced by the switch function
      addDependency(pkg, pkgName, '*', !!options.dev)
      savePackageJson(projectRoot, pkg)
      console.log(`Added ${pkgName} to ${options.dev ? 'devDependencies' : 'dependencies'}`)
    }

    if (activateSource === 'local' && relLocalPath) {
      switchToLocal(projectRoot, pkgName, relLocalPath, workspaceRoot)
      if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot)
      }
    } else if (activateSource === 'github' && github) {
      switchToGitHub(projectRoot, pkgName, depConfig, undefined, workspaceRoot)
      if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot)
      }
    } else if (activateSource === 'gitlab' && gitlab) {
      switchToGitLab(projectRoot, pkgName, depConfig, undefined, workspaceRoot)
      if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot)
      }
    } else if (needsAdd) {
      // No activation source but we added the dep - use npm latest
      const npmPkgName = depConfig.npm ?? pkgName
      const latestVersion = getLatestNpmVersion(npmPkgName)
      const pkgUpdated = loadPackageJson(projectRoot)
      updatePackageJsonDep(pkgUpdated, pkgName, `^${latestVersion}`)
      savePackageJson(projectRoot, pkgUpdated)
      console.log(`Set ${pkgName} to npm: ^${latestVersion}`)
      if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot)
      }
    }
  })

program
  .command('set [dep]')
  .description('Update fields for an existing dependency')
  .option('-b, --dist-branch <branch>', 'Set dist branch')
  .option('-H, --github <repo>', 'Set GitHub repo (use "" to remove)')
  .option('-l, --local <path>', 'Set local path (use "" to remove)')
  .option('-L, --gitlab <repo>', 'Set GitLab repo (use "" to remove)')
  .option('-n, --npm <name>', 'Set NPM package name')
  .action((depQuery: string | undefined, options: { distBranch?: string; github?: string; gitlab?: string; local?: string; npm?: string }) => {
    const isGlobal = program.opts().global
    const projectRoot = isGlobal ? '' : findProjectRoot()
    const config = isGlobal ? loadGlobalConfig() : loadConfig(projectRoot)

    const [name, dep] = findMatchingDep(config, depQuery)
    if (!dep) {
      console.error(`Dependency not found: ${depQuery}`)
      process.exit(1)
    }

    let changed = false

    if (options.local !== undefined) {
      if (options.local === '') {
        delete (dep as unknown as Record<string, unknown>).localPath
        console.log(`  Removed local path`)
      } else {
        const absPath = resolve(options.local)
        dep.localPath = isGlobal ? absPath : relative(projectRoot, absPath)
        console.log(`  Local path: ${dep.localPath}`)
      }
      changed = true
    }

    if (options.github !== undefined) {
      if (options.github === '') {
        delete dep.github
        console.log(`  Removed GitHub`)
      } else {
        dep.github = options.github
        console.log(`  GitHub: ${options.github}`)
      }
      changed = true
    }

    if (options.gitlab !== undefined) {
      if (options.gitlab === '') {
        delete dep.gitlab
        console.log(`  Removed GitLab`)
      } else {
        dep.gitlab = options.gitlab
        console.log(`  GitLab: ${options.gitlab}`)
      }
      changed = true
    }

    if (options.npm !== undefined) {
      dep.npm = options.npm
      console.log(`  NPM: ${options.npm}`)
      changed = true
    }

    if (options.distBranch !== undefined) {
      dep.distBranch = options.distBranch
      console.log(`  Dist branch: ${options.distBranch}`)
      changed = true
    }

    if (!changed) {
      console.log(`No changes specified. Use -l, -H, -L, -n, or -b to update fields.`)
      return
    }

    if (isGlobal) {
      saveGlobalConfig(config)
    } else {
      saveConfig(projectRoot, config)
    }
    console.log(`Updated ${name}`)
  })

function removeDependency(pkg: Record<string, unknown>, depName: string): boolean {
  const deps = pkg.dependencies as Record<string, string> | undefined
  const devDeps = pkg.devDependencies as Record<string, string> | undefined

  if (deps && depName in deps) {
    delete deps[depName]
    return true
  }
  if (devDeps && depName in devDeps) {
    delete devDeps[depName]
    return true
  }
  return false
}

// Helper to clean up workspace/vite when removing a dep
function cleanupDepReferences(projectRoot: string, depName: string, depConfig: DepConfig, workspaceRoot?: string | null): void {
  // Clean up pnpm-workspace.yaml if the dep was in it
  if (depConfig.localPath) {
    const wsRoot = workspaceRoot ?? projectRoot
    const ws = loadWorkspaceYaml(wsRoot)
    if (ws?.packages) {
      const wsLocalPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot)
      ws.packages = ws.packages.filter(p => p !== wsLocalPath)
      if (workspaceRoot) {
        saveWorkspaceYaml(wsRoot, ws)
      } else if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
        saveWorkspaceYaml(wsRoot, null)
      } else {
        saveWorkspaceYaml(wsRoot, ws)
      }
    }
  }

  // Clean up vite.config.ts
  updateViteConfig(projectRoot, depName, false)
}

program
  .command('deinit [dep]')
  .alias('di')
  .description('Stop tracking a dependency with pds (keeps in package.json)')
  .action((depQuery: string | undefined) => {
    const isGlobal = program.opts().global
    const projectRoot = isGlobal ? '' : findProjectRoot()
    const workspaceRoot = isGlobal ? null : findWorkspaceRoot(projectRoot)
    const config = isGlobal ? loadGlobalConfig() : loadConfig(projectRoot)

    const [name, depConfig] = findMatchingDep(config, depQuery)

    // Remove from pds config
    delete config.dependencies[name]

    if (!isGlobal) {
      cleanupDepReferences(projectRoot, name, depConfig, workspaceRoot)
    }

    if (isGlobal) {
      saveGlobalConfig(config)
    } else {
      saveConfig(projectRoot, config)
    }

    console.log(`Stopped tracking ${name}${isGlobal ? ' (global)' : ''}`)
  })

program
  .command('rm [dep]')
  .aliases(['r', 'remove'])
  .description('Remove a dependency from pds config and package.json')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string | undefined, options: { install: boolean }) => {
    const isGlobal = program.opts().global
    const projectRoot = isGlobal ? '' : findProjectRoot()
    const workspaceRoot = isGlobal ? null : findWorkspaceRoot(projectRoot)
    const config = isGlobal ? loadGlobalConfig() : loadConfig(projectRoot)

    const [name, depConfig] = findMatchingDep(config, depQuery)

    // Remove from pds config
    delete config.dependencies[name]

    if (isGlobal) {
      saveGlobalConfig(config)
      // Uninstall globally
      console.log(`Removing ${name} globally...`)
      execSync(`pnpm rm -g ${depConfig.npm ?? name}`, { stdio: 'inherit' })
      console.log(`Removed ${name} (global)`)
    } else {
      cleanupDepReferences(projectRoot, name, depConfig, workspaceRoot)
      saveConfig(projectRoot, config)

      // Remove from package.json
      const pkg = loadPackageJson(projectRoot)
      if (removeDependency(pkg, name)) {
        savePackageJson(projectRoot, pkg)
        console.log(`Removed ${name} from package.json`)
      }

      if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot)
      }
    }
  })

// Fetch remote version info for a dependency (for verbose listing)
function fetchRemoteVersions(dep: DepConfig, depName: string): RemoteVersions {
  const result: RemoteVersions = {}
  const distBranch = dep.distBranch ?? 'dist'

  const npmName = dep.npm ?? depName
  try {
    result.npm = getLatestNpmVersion(npmName)
  } catch {}

  if (dep.github) {
    try {
      const sha = resolveGitHubRef(dep.github, distBranch)
      result.github = sha.slice(0, 7)
    } catch {}
    try {
      const pkg = fetchGitHubPackageJson(dep.github, distBranch)
      result.githubVersion = pkg.version as string | undefined
    } catch {}
  }

  if (dep.gitlab) {
    try {
      const sha = resolveGitLabRef(dep.gitlab, distBranch)
      result.gitlab = sha.slice(0, 7)
    } catch {}
    try {
      const pkg = fetchGitLabPackageJson(dep.gitlab, distBranch)
      result.gitlabVersion = pkg.version as string | undefined
    } catch {}
  }

  return result
}

program
  .command('list')
  .alias('ls')
  .description('List configured dependencies and their current sources')
  .option('-a, --all', 'Show both project and global dependencies')
  .option('-v, --verbose', 'Show available remote versions')
  .action(async (options: { all?: boolean; verbose?: boolean }) => {
    await listDepsAsync(options.verbose ?? false, options.all)
  })

// Helper for list/versions commands
async function listDepsAsync(verbose: boolean, all?: boolean): Promise<void> {
  const isGlobal = program.opts().global

  // Kick off global sources fetch early (if needed)
  const globalSourcesPromise = (isGlobal || all)
    ? fetchAllGlobalInstallSourcesAsync()
    : undefined

  if (isGlobal && !all) {
    const config = loadGlobalConfig()

    if (Object.keys(config.dependencies).length === 0) {
      console.log('No global dependencies configured. Use "pds -g init <path>" to add one.')
      return
    }

    const entries = Object.entries(config.dependencies)
    // Launch dep info builds and remote version fetches all concurrently
    const [infos, remoteVersions] = await Promise.all([
      globalSourcesPromise!.then(sources =>
        Promise.all(entries.map(([name, dep]) => buildGlobalDepInfoAsync(name, dep, sources)))
      ),
      verbose
        ? Promise.all(entries.map(([name, dep]) => fetchRemoteVersionsAsync(dep, name)))
        : Promise.resolve([] as RemoteVersions[]),
    ])

    const indexed = infos.map((info, i) => ({ info, versions: remoteVersions[i] }))
    indexed.sort((a, b) => a.info.name.localeCompare(b.info.name))
    for (const { info, versions } of indexed) {
      displayDep(info, verbose, versions)
    }
    return
  }

  // Gather entries from project and global configs
  let projectRoot: string | undefined
  let projectEntries: [string, DepConfig][] = []
  let pkg: Record<string, unknown> | undefined
  if (!isGlobal) {
    projectRoot = findProjectRoot()
    const config = loadConfig(projectRoot)
    pkg = loadPackageJson(projectRoot)

    if (Object.keys(config.dependencies).length === 0 && !all) {
      console.log('No dependencies configured. Use "pds init <path>" to add one.')
      return
    }

    projectEntries = Object.entries(config.dependencies)
  }

  let globalEntries: [string, DepConfig][] = []
  if (all) {
    const globalConfig = loadGlobalConfig()
    globalEntries = Object.entries(globalConfig.dependencies)
  }

  // Launch everything concurrently: dep info builds, global sources, and remote version fetches
  const [projectInfos, globalInfos, projectVersions, globalVersions] = await Promise.all([
    Promise.all(projectEntries.map(([name, dep]) => buildProjectDepInfoAsync(name, dep, projectRoot!, pkg!))),
    globalSourcesPromise
      ? globalSourcesPromise.then(sources =>
          Promise.all(globalEntries.map(([name, dep]) => buildGlobalDepInfoAsync(name, dep, sources)))
        )
      : Promise.resolve([] as DepDisplayInfo[]),
    verbose
      ? Promise.all(projectEntries.map(([name, dep]) => fetchRemoteVersionsAsync(dep, name)))
      : Promise.resolve([] as RemoteVersions[]),
    verbose
      ? Promise.all(globalEntries.map(([name, dep]) => fetchRemoteVersionsAsync(dep, name)))
      : Promise.resolve([] as RemoteVersions[]),
  ])

  // Combine, alpha-sort, and display
  const allDeps = [
    ...projectInfos.map((info, i) => ({ info, versions: projectVersions[i] })),
    ...globalInfos.map((info, i) => ({ info, versions: globalVersions[i] })),
  ]
  allDeps.sort((a, b) => a.info.name.localeCompare(b.info.name))
  for (const { info, versions } of allDeps) {
    displayDep(info, verbose, versions)
  }
}

program
  .command('versions')
  .alias('v')
  .description('List dependencies with available remote versions (alias for ls -v)')
  .action(async () => {
    await listDepsAsync(true)
  })

program
  .command('local [dep]')
  .alias('l')
  .description('Switch dependency to local directory')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string | undefined, options: { install: boolean }) => {
    if (program.opts().global) {
      const config = loadGlobalConfig()
      const [depName, depConfig] = findMatchingDep(config, depQuery)
      runGlobalInstall(`file:${depConfig.localPath}`)
      console.log(`Installed ${depName} globally from local: ${depConfig.localPath}`)
      return
    }

    const projectRoot = findProjectRoot()
    const workspaceRoot = findWorkspaceRoot(projectRoot)
    const config = loadConfig(projectRoot)
    const [depName, depConfig] = findMatchingDep(config, depQuery)

    if (!depConfig.localPath) {
      console.error(`No local path configured for ${depName}. Use "pds set ${depName} -l <path>" to set one.`)
      process.exit(1)
    }

    const absLocalPath = resolve(projectRoot, depConfig.localPath)

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, 'workspace:*')
    savePackageJson(projectRoot, pkg)

    // Update pnpm-workspace.yaml
    const wsRoot = workspaceRoot ?? projectRoot
    const ws = loadWorkspaceYaml(wsRoot) ?? { packages: workspaceRoot ? [] : ['.'] }
    if (!ws.packages) ws.packages = workspaceRoot ? [] : ['.']
    if (!workspaceRoot && !ws.packages.includes('.')) ws.packages.unshift('.')
    const wsLocalPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot)
    if (!ws.packages.includes(wsLocalPath)) {
      ws.packages.push(wsLocalPath)
    }
    saveWorkspaceYaml(wsRoot, ws)

    // Update vite.config.ts
    updateViteConfig(projectRoot, depName, true)

    console.log(`Switched ${depName} to local: ${absLocalPath}`)

    if (options.install) {
      runPnpmInstall(projectRoot, workspaceRoot)
    }
  })

program
  .command('github [dep]')
  .aliases(['gh'])
  .description('Switch dependency to GitHub ref (defaults to dist branch HEAD)')
  .option('-n, --dry-run', 'Show what would be installed without making changes')
  .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
  .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string | undefined, options: { dryRun?: boolean; ref?: string; rawRef?: string; install: boolean }) => {
    const isGlobal = program.opts().global
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot())
    const [depName, depConfig] = findMatchingDep(config, depQuery)

    if (!depConfig.github) {
      throw new Error(`No GitHub repo configured for ${depName}. Use "pds init" with -G/--github`)
    }

    if (options.ref && options.rawRef) {
      throw new Error('Cannot use both -r/--ref and -R/--raw-ref')
    }

    const distBranch = depConfig.distBranch ?? 'dist'

    let resolvedRef: string
    if (options.rawRef) {
      // Raw ref: use as-is
      resolvedRef = options.rawRef
    } else if (options.ref) {
      // Ref provided: resolve to SHA
      resolvedRef = resolveGitHubRef(depConfig.github, options.ref)
    } else {
      // No ref provided: use dist branch, resolve to SHA
      resolvedRef = resolveGitHubRef(depConfig.github, distBranch)
    }

    const specifier = makeGitHubSpecifier(depConfig.github, resolvedRef, depConfig.subdir)

    if (options.dryRun) {
      console.log(`Would switch ${depName} to: ${specifier}`)
      return
    }

    if (isGlobal) {
      runGlobalInstall(specifier)
      console.log(`Installed ${depName} globally from GitHub: ${specifier}`)
      return
    }

    const projectRoot = findProjectRoot()
    const workspaceRoot = findWorkspaceRoot(projectRoot)

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, specifier)
    removePnpmOverride(pkg, depName)
    savePackageJson(projectRoot, pkg)

    // Remove from pnpm-workspace.yaml
    if (depConfig.localPath) {
      const wsRoot = workspaceRoot ?? projectRoot
      const ws = loadWorkspaceYaml(wsRoot)
      if (ws?.packages) {
        const wsPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot)
        ws.packages = ws.packages.filter(p => p !== wsPath)
        if (workspaceRoot) {
          saveWorkspaceYaml(wsRoot, ws)
        } else if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
          saveWorkspaceYaml(wsRoot, null)
        } else {
          saveWorkspaceYaml(wsRoot, ws)
        }
      }
    }

    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false)

    console.log(`Switched ${depName} to GitHub: ${depConfig.github}#${resolvedRef}`)

    if (options.install) {
      runPnpmInstall(projectRoot, workspaceRoot)
    }
  })

program
  .command('gitlab [dep]')
  .aliases(['gl'])
  .description('Switch dependency to GitLab ref (defaults to dist branch HEAD)')
  .option('-n, --dry-run', 'Show what would be installed without making changes')
  .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
  .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string | undefined, options: { dryRun?: boolean; ref?: string; rawRef?: string; install: boolean }) => {
    const isGlobal = program.opts().global
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot())
    const [depName, depConfig] = findMatchingDep(config, depQuery)

    if (!depConfig.gitlab) {
      throw new Error(`No GitLab repo configured for ${depName}. Use "pds init" with -l/--gitlab`)
    }

    if (options.ref && options.rawRef) {
      throw new Error('Cannot use both -r/--ref and -R/--raw-ref')
    }

    const distBranch = depConfig.distBranch ?? 'dist'

    let resolvedRef: string
    if (options.rawRef) {
      // Raw ref: use as-is
      resolvedRef = options.rawRef
    } else if (options.ref) {
      // Ref provided: resolve to SHA
      resolvedRef = resolveGitLabRef(depConfig.gitlab, options.ref)
    } else {
      // No ref provided: use dist branch, resolve to SHA
      resolvedRef = resolveGitLabRef(depConfig.gitlab, distBranch)
    }

    // GitLab uses tarball URL format (pnpm doesn't support gitlab: prefix)
    // Format: https://gitlab.com/{repo}/-/archive/{ref}/{basename}-{ref}.tar.gz
    const repoBasename = depConfig.gitlab.split('/').pop()
    const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${resolvedRef}/${repoBasename}-${resolvedRef}.tar.gz`

    if (options.dryRun) {
      console.log(`Would switch ${depName} to: ${tarballUrl}`)
      return
    }

    if (isGlobal) {
      runGlobalInstall(tarballUrl)
      console.log(`Installed ${depName} globally from GitLab: ${depConfig.gitlab}@${resolvedRef}`)
      return
    }

    const projectRoot = findProjectRoot()
    const workspaceRoot = findWorkspaceRoot(projectRoot)

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, tarballUrl)
    removePnpmOverride(pkg, depName)
    savePackageJson(projectRoot, pkg)

    // Remove from pnpm-workspace.yaml
    if (depConfig.localPath) {
      const wsRoot = workspaceRoot ?? projectRoot
      const ws = loadWorkspaceYaml(wsRoot)
      if (ws?.packages) {
        const wsPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot)
        ws.packages = ws.packages.filter(p => p !== wsPath)
        if (workspaceRoot) {
          saveWorkspaceYaml(wsRoot, ws)
        } else if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
          saveWorkspaceYaml(wsRoot, null)
        } else {
          saveWorkspaceYaml(wsRoot, ws)
        }
      }
    }

    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false)

    console.log(`Switched ${depName} to GitLab: ${depConfig.gitlab}@${resolvedRef}`)

    if (options.install) {
      runPnpmInstall(projectRoot, workspaceRoot)
    }
  })

program
  .command('git [dep]')
  .alias('g')
  .description('Switch dependency to GitHub or GitLab (auto-detects which is configured)')
  .option('-n, --dry-run', 'Show what would be installed without making changes')
  .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
  .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((depQuery: string | undefined, options: { dryRun?: boolean; ref?: string; rawRef?: string; install: boolean }) => {
    const isGlobal = program.opts().global
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot())
    const [depName, depConfig] = findMatchingDep(config, depQuery)

    if (options.ref && options.rawRef) {
      throw new Error('Cannot use both -r/--ref and -R/--raw-ref')
    }

    const hasGitHub = !!depConfig.github
    const hasGitLab = !!depConfig.gitlab

    if (!hasGitHub && !hasGitLab) {
      throw new Error(`No GitHub or GitLab repo configured for ${depName}. Use "pds init" with -H or -L`)
    }
    if (hasGitHub && hasGitLab) {
      throw new Error(`Both GitHub and GitLab configured for ${depName}. Use "pds gh" or "pds gl" explicitly`)
    }

    const distBranch = depConfig.distBranch ?? 'dist'

    // Determine the ref to use
    let resolvedRef: string | undefined
    if (options.rawRef) {
      resolvedRef = options.rawRef
    } else if (options.ref) {
      // Resolve via the appropriate API
      resolvedRef = hasGitHub
        ? resolveGitHubRef(depConfig.github!, options.ref)
        : resolveGitLabRef(depConfig.gitlab!, options.ref)
    }

    // Resolve ref for dry-run or actual switch
    if (hasGitHub) {
      const ref = resolvedRef ?? resolveGitHubRef(depConfig.github!, distBranch)
      const specifier = makeGitHubSpecifier(depConfig.github!, ref, depConfig.subdir)

      if (options.dryRun) {
        console.log(`Would switch ${depName} to: ${specifier}`)
        return
      }

      if (isGlobal) {
        runGlobalInstall(specifier)
        console.log(`Installed ${depName} globally from GitHub: ${specifier}`)
        return
      }

      const projectRoot = findProjectRoot()
      const workspaceRoot = findWorkspaceRoot(projectRoot)
      switchToGitHub(projectRoot, depName, depConfig, ref, workspaceRoot)
      if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot)
      }
    } else {
      const ref = resolvedRef ?? resolveGitLabRef(depConfig.gitlab!, distBranch)
      const repoBasename = depConfig.gitlab!.split('/').pop()
      const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${ref}/${repoBasename}-${ref}.tar.gz`

      if (options.dryRun) {
        console.log(`Would switch ${depName} to: ${tarballUrl}`)
        return
      }

      if (isGlobal) {
        runGlobalInstall(tarballUrl)
        console.log(`Installed ${depName} globally from GitLab: ${depConfig.gitlab}@${ref}`)
        return
      }

      const projectRoot = findProjectRoot()
      const workspaceRoot = findWorkspaceRoot(projectRoot)
      switchToGitLab(projectRoot, depName, depConfig, ref, workspaceRoot)
      if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot)
      }
    }
  })

program
  .command('npm [dep] [version]')
  .alias('n')
  .description('Switch dependency to NPM (defaults to latest)')
  .option('-n, --dry-run', 'Show what would be installed without making changes')
  .option('-I, --no-install', 'Skip running pnpm install')
  .action((arg1: string | undefined, arg2: string | undefined, options: { dryRun?: boolean; install: boolean }) => {
    const isGlobal = program.opts().global
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot())
    const deps = Object.entries(config.dependencies)

    // If only one arg and exactly one dep configured, decide whether it's a version or dep query.
    // Versions start with a digit; anything else is a dep query (substring match).
    let depQuery: string | undefined
    let version: string | undefined
    if (arg1 && !arg2 && deps.length === 1 && /^\d/.test(arg1)) {
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
    const specifier = `^${resolvedVersion}`

    if (options.dryRun) {
      console.log(`Would switch ${depName} to: ${specifier}`)
      return
    }

    if (isGlobal) {
      runGlobalInstall(`${npmName}@${resolvedVersion}`)
      console.log(`Installed ${depName} globally from NPM: ${npmName}@${resolvedVersion}`)
      return
    }

    const projectRoot = findProjectRoot()
    const workspaceRoot = findWorkspaceRoot(projectRoot)

    const pkg = loadPackageJson(projectRoot)
    updatePackageJsonDep(pkg, depName, specifier)
    removePnpmOverride(pkg, depName)
    savePackageJson(projectRoot, pkg)

    // Remove from pnpm-workspace.yaml
    if (depConfig.localPath) {
      const wsRoot = workspaceRoot ?? projectRoot
      const ws = loadWorkspaceYaml(wsRoot)
      if (ws?.packages) {
        const wsPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot)
        ws.packages = ws.packages.filter(p => p !== wsPath)
        if (workspaceRoot) {
          saveWorkspaceYaml(wsRoot, ws)
        } else if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
          saveWorkspaceYaml(wsRoot, null)
        } else {
          saveWorkspaceYaml(wsRoot, ws)
        }
      }
    }

    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false)

    console.log(`Switched ${depName} to NPM: ${specifier}`)

    if (options.install) {
      runPnpmInstall(projectRoot, workspaceRoot)
    }
  })

program
  .command('status [dep]')
  .alias('s')
  .description('Show current source for dependency (or all if none specified)')
  .action((depQuery: string | undefined) => {
    if (program.opts().global) {
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
      const sourceType = getSourceType(current)

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

const GLOBAL_HOOKS_DIR = join(GLOBAL_CONFIG_DIR, 'hooks')

// Check if any pds-managed deps are set to local (workspace:*)
function checkLocalDeps(projectRoot: string): { name: string; source: string }[] {
  const configPath = resolveConfigPath(projectRoot)
  if (!existsSync(configPath)) {
    return [] // No pds config, nothing to check
  }

  const config = loadConfig(projectRoot)
  const pkg = loadPackageJson(projectRoot)
  const localDeps: { name: string; source: string }[] = []

  for (const name of Object.keys(config.dependencies)) {
    const source = getCurrentSource(pkg, name)
    if (source === 'workspace:*') {
      localDeps.push({ name, source })
    }
  }

  return localDeps
}

function resolveCheckOn(projectConfig: Config): "pre-push" | "pre-commit" | "none" {
  if (projectConfig.checkOn) return projectConfig.checkOn
  if (projectConfig.skipCheck) return "none"
  const globalConfig = loadGlobalConfig()
  if (globalConfig.checkOn) return globalConfig.checkOn
  return "pre-push"
}

program
  .command('check')
  .description('Check if any pds-managed deps are set to local (for git hooks)')
  .option('-q, --quiet', 'Exit with code only, no output')
  .option('--hook <type>', 'Hook type invoking this check (pre-push or pre-commit)')
  .action((options: { quiet?: boolean; hook?: string }) => {
    let projectRoot: string
    try {
      projectRoot = findProjectRoot()
    } catch {
      // Not in a JS project, nothing to check
      if (!options.quiet) {
        console.log('Not in a JS project, skipping check.')
      }
      return
    }

    const config = loadConfig(projectRoot)
    const checkOn = resolveCheckOn(config)

    // When invoked from a hook, skip if this hook type shouldn't run the check
    if (options.hook) {
      if (checkOn === "none" || checkOn !== options.hook) {
        return
      }
    } else {
      // Manual invocation: still respect checkOn: "none" / skipCheck
      if (checkOn === "none") {
        if (!options.quiet) {
          console.log('Check disabled for this project (checkOn: "none").')
        }
        return
      }
    }

    const localDeps = checkLocalDeps(projectRoot)

    if (localDeps.length === 0) {
      if (!options.quiet) {
        console.log('No local dependencies found.')
      }
      return
    }

    const verb = checkOn === "pre-commit" ? "committing" : "pushing"
    const bypass = checkOn === "pre-commit" ? "git commit --no-verify" : "git push --no-verify"

    if (!options.quiet) {
      console.error('Error: The following dependencies are set to local:')
      for (const { name } of localDeps) {
        console.error(`  - ${name}`)
      }
      console.error(`\nSwitch them before ${verb}:`)
      console.error('  pds gh <dep>   # Switch to GitHub')
      console.error('  pds gl <dep>   # Switch to GitLab')
      console.error('  pds npm <dep>  # Switch to NPM')
      console.error(`\nOr bypass with: ${bypass}`)
    }
    process.exit(1)
  })

const HOOKS_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'hooks.json')

interface HooksConfig {
  previousHooksPath?: string  // Saved core.hooksPath before pds install
}

function loadHooksConfig(): HooksConfig {
  if (!existsSync(HOOKS_CONFIG_FILE)) {
    return {}
  }
  return JSON.parse(readFileSync(HOOKS_CONFIG_FILE, 'utf-8'))
}

function saveHooksConfig(config: HooksConfig): void {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
  }
  writeFileSync(HOOKS_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}

function generateHookScript(hookType: string, previousHooksPath?: string): string {
  const previousHooksSection = previousHooksPath
    ? `if [ -x "${previousHooksPath}/${hookType}" ]; then
  "${previousHooksPath}/${hookType}" || exit 1
fi`
    : '# (no previous core.hooksPath)'

  return `#!/bin/sh
# pds ${hookType} hook - checks for local dependencies
# Installed by: pds hooks install

# 1. Run pds check
if command -v pds >/dev/null 2>&1; then
  pds check --hook ${hookType} || exit 1
else
  echo "Warning: pds not found in PATH, skipping local dependency check"
fi

# 2. Chain to previous global hooks (if any were configured before pds)
${previousHooksSection}

# 3. Chain to local .git/hooks (which Git ignores when core.hooksPath is set)
if [ -x .git/hooks/${hookType} ]; then
  .git/hooks/${hookType} || exit 1
fi
`
}

const hooks = program
  .command('hooks')
  .description('Manage git hooks for pds')

hooks
  .command('install')
  .description('Install global git hooks for pds (pre-push and pre-commit)')
  .option('-f, --force', 'Overwrite existing core.hooksPath')
  .action((options: { force?: boolean }) => {
    // Check if core.hooksPath is already set
    const existingPath = spawnSync('git', ['config', '--global', 'core.hooksPath'], {
      encoding: 'utf-8',
    })
    const currentHooksPath = existingPath.stdout.trim()
    let previousHooksPath: string | undefined

    if (currentHooksPath && currentHooksPath !== GLOBAL_HOOKS_DIR) {
      if (!options.force) {
        console.error(`Error: core.hooksPath is already set to: ${currentHooksPath}`)
        console.error('Use --force to chain to existing hooks.')
        process.exit(1)
      }
      // Save the previous path so we can chain to it
      previousHooksPath = currentHooksPath
      console.log(`Chaining to existing hooks: ${currentHooksPath}`)
    }

    // Create hooks directory
    if (!existsSync(GLOBAL_HOOKS_DIR)) {
      mkdirSync(GLOBAL_HOOKS_DIR, { recursive: true })
    }

    // Save hooks config (previous path for chaining and uninstall)
    const hooksConfig: HooksConfig = {}
    if (previousHooksPath) {
      hooksConfig.previousHooksPath = previousHooksPath
    }
    saveHooksConfig(hooksConfig)

    // Write both hook scripts
    for (const hookType of ['pre-push', 'pre-commit']) {
      const hookPath = join(GLOBAL_HOOKS_DIR, hookType)
      writeFileSync(hookPath, generateHookScript(hookType, previousHooksPath))
      execSync(`chmod +x "${hookPath}"`)
    }

    // Set global core.hooksPath
    execSync(`git config --global core.hooksPath "${GLOBAL_HOOKS_DIR}"`)

    console.log('Installed global git hooks (pre-push + pre-commit).')
    console.log(`  Hooks directory: ${GLOBAL_HOOKS_DIR}`)
    console.log(`  Default check runs on: pre-push`)
    console.log(`  Per-project override: set "checkOn" in .pds.json`)
    if (previousHooksPath) {
      console.log(`  Chaining to: ${previousHooksPath}`)
    }
    console.log('  Also chains to local .git/hooks/ if present')
  })

hooks
  .command('uninstall')
  .description('Remove global git hooks for pds')
  .action(() => {
    // Check if our hooks are installed
    const existingPath = spawnSync('git', ['config', '--global', 'core.hooksPath'], {
      encoding: 'utf-8',
    })
    const currentHooksPath = existingPath.stdout.trim()

    if (currentHooksPath !== GLOBAL_HOOKS_DIR) {
      if (currentHooksPath) {
        console.log(`core.hooksPath is set to a different directory: ${currentHooksPath}`)
        console.log('Not modifying.')
      } else {
        console.log('No global hooks path configured.')
      }
      return
    }

    // Load hooks config to check for previous path
    const hooksConfig = loadHooksConfig()

    // Restore previous core.hooksPath or unset
    if (hooksConfig.previousHooksPath) {
      execSync(`git config --global core.hooksPath "${hooksConfig.previousHooksPath}"`)
      console.log(`Restored previous core.hooksPath: ${hooksConfig.previousHooksPath}`)
    } else {
      execSync('git config --global --unset core.hooksPath')
      console.log('Unset core.hooksPath')
    }

    // Remove both hook files
    for (const hookType of ['pre-push', 'pre-commit']) {
      const hookPath = join(GLOBAL_HOOKS_DIR, hookType)
      if (existsSync(hookPath)) {
        execSync(`rm "${hookPath}"`)
      }
    }

    // Remove hooks config
    if (existsSync(HOOKS_CONFIG_FILE)) {
      execSync(`rm "${HOOKS_CONFIG_FILE}"`)
    }

    console.log('Removed pds hooks.')
  })

hooks
  .command('status')
  .description('Show hooks installation status')
  .action(() => {
    const existingPath = spawnSync('git', ['config', '--global', 'core.hooksPath'], {
      encoding: 'utf-8',
    })
    const currentHooksPath = existingPath.stdout.trim()

    if (!currentHooksPath) {
      console.log('Status: Not installed')
      console.log('  No global core.hooksPath configured')
      return
    }

    if (currentHooksPath === GLOBAL_HOOKS_DIR) {
      const hooksConfig = loadHooksConfig()
      console.log('Status: Installed')
      console.log(`  core.hooksPath: ${currentHooksPath}`)
      for (const hookType of ['pre-push', 'pre-commit']) {
        const hookPath = join(GLOBAL_HOOKS_DIR, hookType)
        console.log(`  ${hookType} hook: ${existsSync(hookPath) ? 'present' : 'missing'}`)
      }
      if (hooksConfig.previousHooksPath) {
        console.log(`  chaining to: ${hooksConfig.previousHooksPath}`)
      }
      console.log('  chains to local .git/hooks/ if present')
    } else {
      console.log('Status: Different hooks path configured')
      console.log(`  core.hooksPath: ${currentHooksPath}`)
      console.log(`  (not managed by pds)`)
    }
  })

const SHELL_ALIASES = `# pds shell aliases
# Add to your shell rc file: eval "$(pds shell-integration)"

alias pdg='pds -g'     # global mode (pdg ls, pdg gh, etc.)
alias pdgg='pds -g g'     # global git (auto-detect GitHub/GitLab)
alias pdgi='pds -g init'  # global init
alias pdsg='pds g'     # git (auto-detect GitHub/GitLab)
alias pdi='pds init'   # init
alias pdid='pds init -D'  # init as devDependency
alias pdsi='pds init'  # init (alt)
alias pdl='pds ls'     # list
alias pdla='pds ls -a' # list all (project + global)
alias pdlv='pds ls -v'    # list with versions
alias pdlav='pds ls -av'  # list all with versions
alias pdlg='pds -g ls'   # global list
alias pdav='pds ls -av'   # list all with versions (alt)
alias pdgv='pds -g ls -v' # global list with versions
alias pdsl='pds l'     # local
alias pdgh='pds gh'    # github
alias pdgl='pds gl'    # gitlab
alias pdsn='pds n'     # npm
alias pdsv='pds v'     # versions
alias pdss='pds s'     # status
alias pdsc='pds check' # check for local deps
alias pddi='pds di'    # deinit (stop tracking, keep in package.json)
alias pdr='pds rm'     # remove (from pds config and package.json)
alias pdgr='pds -g rm' # global remove
`

program
  .command('shell-integration')
  .alias('shell')
  .description('Output shell aliases for eval (add to .bashrc/.zshrc)')
  .action(() => {
    console.log(SHELL_ALIASES)
  })

// Default to 'list' if deps configured, otherwise show help
// Also handle `pds -g` as shorthand for `pds -g ls`
const hasOnlyGlobalFlag = process.argv.length === 3 && (process.argv[2] === '-g' || process.argv[2] === '--global')
if (process.argv.length <= 2 || hasOnlyGlobalFlag) {
  // Check if there are any deps configured
  const isGlobal = hasOnlyGlobalFlag
  try {
    if (isGlobal) {
      const config = loadGlobalConfig()
      if (Object.keys(config.dependencies).length > 0) {
        process.argv.push('list')
      } else {
        process.argv.push('--help')
      }
    } else {
      const projectRoot = findProjectRoot()
      const config = loadConfig(projectRoot)
      if (Object.keys(config.dependencies).length > 0) {
        process.argv.push('list')
      } else {
        process.argv.push('--help')
      }
    }
  } catch {
    // Not in a project or error - show help
    process.argv.push('--help')
  }
}

try {
  await program.parseAsync()
} catch (err) {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`)
  } else {
    console.error('An unknown error occurred')
  }
  process.exit(1)
}
