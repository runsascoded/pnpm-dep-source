import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

import type { PackageInfo } from './types.js'
import { spawnAsync } from './process.js'

export function getLocalGitInfo(localPath: string): { sha: string; dirty: boolean } | null {
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

export async function getLocalGitInfoAsync(localPath: string): Promise<{ sha: string; dirty: boolean } | null> {
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

export function resolveGitHubRef(repo: string, ref: string): string {
  // Use gh api to resolve ref to SHA from GitHub
  const result = spawnSync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to resolve GitHub ref "${ref}" for ${repo}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

export async function resolveGitHubRefAsync(repo: string, ref: string): Promise<string> {
  const result = await spawnAsync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`Failed to resolve GitHub ref "${ref}" for ${repo}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

export function resolveGitLabRef(repo: string, ref: string): string {
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

export async function resolveGitLabRefAsync(repo: string, ref: string): Promise<string> {
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

// Parse GitHub/GitLab repo from a URL string
export function parseRepoUrl(repoUrl: string): { github?: string; gitlab?: string } {
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
export function parsePackageJson(pkg: Record<string, unknown>): PackageInfo {
  const result: PackageInfo = { name: pkg.name as string }
  if (pkg.private === true) result.private = true

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
export function fetchGitHubPackageJson(repo: string, ref = 'HEAD'): Record<string, unknown> {
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
export function fetchGitLabPackageJson(repo: string, ref = 'HEAD'): Record<string, unknown> {
  const encodedPath = encodeURIComponent(repo)
  const result = spawnSync('glab', ['api', `projects/${encodedPath}/repository/files/package.json/raw?ref=${ref}`], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to fetch package.json from GitLab ${repo}: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

export async function fetchGitHubPackageJsonAsync(repo: string, ref = 'HEAD'): Promise<Record<string, unknown>> {
  const result = await spawnAsync('gh', ['api', `repos/${repo}/contents/package.json?ref=${ref}`, '--jq', '.content'], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`Failed to fetch package.json from GitHub ${repo}: ${result.stderr}`)
  }
  const content = Buffer.from(result.stdout.trim(), 'base64').toString('utf-8')
  return JSON.parse(content)
}

export async function fetchGitLabPackageJsonAsync(repo: string, ref = 'HEAD'): Promise<Record<string, unknown>> {
  const encodedPath = encodeURIComponent(repo)
  const result = await spawnAsync('glab', ['api', `projects/${encodedPath}/repository/files/package.json/raw?ref=${ref}`], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`Failed to fetch package.json from GitLab ${repo}: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

// Detect GitHub/GitLab repo from git remote in or above the given path
// Also returns subdir if startPath is inside a subdirectory of the repo
export function detectGitRepo(startPath: string): { github?: string; gitlab?: string; subdir?: string } | null {
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
export function getLocalPackageInfo(localPath: string): PackageInfo & { subdir?: string } {
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
export function getRemotePackageInfo(url: string): PackageInfo & { github?: string; gitlab?: string } {
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
export function isRepoUrl(arg: string): boolean {
  return arg.startsWith('http://') ||
    arg.startsWith('https://') ||
    arg.startsWith('github:') ||
    arg.startsWith('gitlab:') ||
    arg.startsWith('git@')
}

export function getLocalPackageName(localPath: string): string {
  return getLocalPackageInfo(localPath).name
}

export function getLatestNpmVersion(packageName: string): string {
  const result = spawnSync('npm', ['view', packageName, 'version'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to get latest version for ${packageName}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

export function npmPackageExists(packageName: string): boolean {
  const result = spawnSync('npm', ['view', packageName, 'version'], {
    encoding: 'utf-8',
  })
  return result.status === 0
}

export async function getLatestNpmVersionAsync(packageName: string): Promise<string> {
  const result = await spawnAsync('npm', ['view', packageName, 'version'], { encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`Failed to get latest version for ${packageName}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

// Cache for global install sources (fetched once via pnpm list -g --json)
let globalInstallCache: Map<string, { source: string; specifier: string }> | null = null

export function parseGlobalPkgSource(
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

export function fetchAllGlobalInstallSources(): Map<string, { source: string; specifier: string }> {
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

export async function fetchAllGlobalInstallSourcesAsync(): Promise<Map<string, { source: string; specifier: string }>> {
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

export function getGlobalInstallSource(packageName = 'pnpm-dep-source'): { source: string; specifier: string } | null {
  return fetchAllGlobalInstallSources().get(packageName) ?? null
}
