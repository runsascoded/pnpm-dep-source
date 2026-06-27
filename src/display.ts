import { resolve } from 'path'

import type { DepConfig, DepDisplayInfo, RemoteVersions } from './types.js'
import { log } from './log.js'
import { c } from './constants.js'
import { getCurrentSource, getCommittedPackageJson, getInstalledVersion, getGlobalInstalledVersion } from './pkg.js'
import {
  getLocalGitInfo, getLocalGitInfoAsync,
  getGlobalInstallSource,
  parseDistSourceSha, gitRevListCountAsync, isCommitReachableAsync, resolveVersionTagAsync,
  resolveGitHubRef, resolveGitLabRef,
  resolveGitHubRefAsync, resolveGitLabRefAsync,
  fetchGitHubPackageJson, fetchGitLabPackageJson,
  fetchGitHubPackageJsonAsync, fetchGitLabPackageJsonAsync,
  getLatestNpmVersion,
  getNpmInfoAsync, baseVersion,
} from './remote.js'

export function getSourceType(source: string): 'local' | 'github' | 'gitlab' | 'cr' | 'npm' | 'unknown' {
  if (source === 'workspace:*' || source === 'local' || source.startsWith('link:') || source.startsWith('file:')) return 'local'
  if (source.includes('pkg.pr.new')) return 'cr'
  if (source.startsWith('github:') || source.includes('github.com/')) return 'github'
  if (source.includes('gitlab.com') && source.includes('/-/archive/')) return 'gitlab'
  if (source.match(/^\^?\d|^latest/)) return 'npm'
  return 'unknown'
}

export function formatGitInfo(info: { sha: string; dirty: boolean } | null): string {
  if (!info) return ''
  const dirtyStr = info.dirty ? ` ${c.red}dirty${c.reset}` : ''
  return ` ${c.blue}(${info.sha}${dirtyStr}${c.blue})${c.reset}`
}

export function formatAheadCount(n: number | undefined): string {
  if (!n || n <= 0) return ''
  return `${c.green}+${n}${c.reset}`
}

export function formatAheadBehind(ahead?: number, behind?: number): string {
  const a = ahead && ahead > 0 ? ahead : 0
  const b = behind && behind > 0 ? behind : 0
  if (a > 0 && b > 0) return ` ${c.green}+${a}${c.red}-${b}${c.reset}`
  if (a > 0) return ` ${c.green}+${a}${c.reset}`
  if (b > 0) return ` ${c.red}-${b}${c.reset}`
  return ''
}

// Extract the pinned SHA from a GitHub/GitLab/pkg.pr.new source specifier
export function extractSourceSha(source: string): string | undefined {
  // pkg.pr.new: https://pkg.pr.new/<owner>/<repo>/<npmName>@<sha> (npm scope also
  // contains '@', so match the trailing @<hex> only)
  const crMatch = source.match(/pkg\.pr\.new\/.+@([0-9a-f]+)$/)
  if (crMatch) return crMatch[1].slice(0, 7)
  // GitHub: github:user/repo#sha or https://github.com/user/repo#sha
  const ghMatch = source.match(/#([a-f0-9]+)$/)
  if (ghMatch) return ghMatch[1].slice(0, 7)
  // GitLab: https://gitlab.com/user/repo/-/archive/<sha>/repo-<sha>.tar.gz
  const glMatch = source.match(/\/-\/archive\/([^/]+)\//)
  if (glMatch) return glMatch[1].slice(0, 7)
  return undefined
}

// Get the raw parts for the active source (sha, version, etc.)
export function getActiveParts(info: DepDisplayInfo): string[] {
  if (info.sourceType === 'local') return []

  const parts: string[] = []

  if (info.isGlobal && info.currentSpecifier) {
    parts.push(info.currentSpecifier)
  } else {
    const sha = extractSourceSha(info.currentSource)
    if (sha) parts.push(sha)
    if (info.version) parts.push(info.version)
  }

  return parts
}

// Build blue-colored parenthesized suffix showing current ref/version for the active line
export function formatActiveSuffix(info: DepDisplayInfo): string {
  const parts = getActiveParts(info)
  if (parts.length === 0) return ''
  return ` ${c.blue}(${parts.join('; ')})${c.reset}`
}

export function displayDep(
  info: DepDisplayInfo,
  verbose: boolean = false,
  remoteVersions?: RemoteVersions,
): void {
  const nameColor = info.isGlobal ? c.magenta : info.isDev ? c.yellow : c.cyan
  const tag = info.isGlobal ? ` ${c.magenta}[global]${c.reset}`
    : info.isDev ? ` ${c.yellow}[dev]${c.reset}`
    : ''
  console.log(`${c.bold}${nameColor}${info.name}${c.reset}${tag}:`)

  const active = info.sourceType
  const versions = verbose ? (remoteVersions ?? fetchRemoteVersions(info.config, info.name)) : undefined

  function line(label: string, isActive: boolean, value: string, suffix: string = ''): void {
    const prefix = isActive ? `${c.green}*${c.reset} ` : '  '
    const coloredLabel = isActive ? `${c.green}${label}${c.reset}` : label
    console.log(`${prefix}${coloredLabel}: ${value}${suffix}`)
  }

  if (info.config.localPath) {
    const gitSuffix = info.gitInfo ? formatGitInfo(info.gitInfo) : ''
    const aheadStr = formatAheadCount(versions?.localAheadOfPinned)
    const aheadSuffix = aheadStr ? ` ${aheadStr}` : ''
    line('Local', active === 'local', info.config.localPath, gitSuffix + aheadSuffix)
  }
  // Helper for GitHub/GitLab display with committed transition and pinned/latest sub-lines
  function showDistLine(
    label: string,
    repo: string,
    isActive: boolean,
    distSha?: string,
    distVersion?: string,
  ): void {
    const subdirSuffix = info.config.subdir ? ` ${c.cyan}[${info.config.subdir}]${c.reset}` : ''
    const distParts = [distSha, distVersion].filter(Boolean) as string[]
    const pinnedParts = isActive ? getActiveParts(info) : []
    const activeSuffix = isActive ? formatActiveSuffix(info) : ''
    const distDelta = formatAheadBehind(versions?.distAheadOfPinned, versions?.pinnedAheadOfDist)

    // Committed transition: show was/now sub-lines
    if (isActive && versions?.committedDistSha) {
      const committedSrcSha = versions.committedDistVersion
        ? parseDistSourceSha(versions.committedDistVersion) : undefined
      const currentSha = extractSourceSha(info.currentSource)
      const currentSrcSha = info.version ? parseDistSourceSha(info.version) : undefined
      line(label, true, repo + subdirSuffix, '')
      const wasParts = [versions.committedDistSha, committedSrcSha].filter(Boolean)
      const nowParts = [currentSha, currentSrcSha].filter(Boolean)
      console.log(`      ${c.red}was: ${wasParts.join(' (src: ')}${committedSrcSha ? ')' : ''}${c.reset}`)
      console.log(`      ${c.green}now: ${nowParts.join(' (src: ')}${currentSrcSha ? ')' : ''}${c.reset}`)
      if (distParts.length && currentSha !== distSha) {
        console.log(`      ${c.blue}latest: ${distParts.join('; ')}${c.reset}${distDelta}`)
      }
    } else if (isActive && distParts.length && !distParts.every(p => activeSuffix.includes(p))) {
      line(label, true, repo + subdirSuffix, '')
      const lostSuffix = versions?.pinnedSrcMissing ? ` ${c.red}(src lost)${c.reset}` : ''
      console.log(`      ${c.blue}pinned: ${pinnedParts.join('; ')}${c.reset}${lostSuffix}`)
      console.log(`      ${c.blue}latest: ${distParts.join('; ')}${c.reset}${distDelta}`)
    } else {
      const distSuffix = !isActive && distParts.length ? ` ${c.blue}(dist@${distParts.join('; ')})${c.reset}${distDelta}` : ''
      line(label, isActive, repo + subdirSuffix, activeSuffix + distSuffix)
    }
  }

  // pkg.pr.new derives from github + npm (no dedicated config field), so only
  // surface it as a line when it's the active source — pinned to its SHA.
  if (active === 'cr') {
    const repo = info.config.github ?? '(pkg.pr.new)'
    line('pkg.pr.new', true, repo, formatActiveSuffix(info))
  }
  if (info.config.github) {
    showDistLine('GitHub', info.config.github, active === 'github', versions?.github, versions?.githubVersion)
  }
  if (info.config.gitlab) {
    showDistLine('GitLab', info.config.gitlab, active === 'gitlab', versions?.gitlab, versions?.gitlabVersion)
  }
  if (info.config.npm) {
    const isActive = active === 'npm'
    // In verbose mode, omit NPM line if no published version exists and npm isn't the active source
    if (verbose && !isActive && !versions?.npm) return
    const activeSuffix = isActive ? formatActiveSuffix(info) : ''
    const npmDelta = formatAheadBehind(versions?.npmAheadOfDist, versions?.distAheadOfNpm)
    const shaSuffix = versions?.npmSourceSha ? `, src: ${versions.npmSourceSha.slice(0, 7)}` : ''
    const latestSuffix = versions?.npm ? ` ${c.blue}(latest: ${versions.npm}${shaSuffix})${c.reset}${npmDelta}` : ''
    line('NPM', isActive, info.config.npm, activeSuffix + latestSuffix)
  }
}

export function buildGlobalDepInfo(name: string, dep: DepConfig): DepDisplayInfo {
  const installSource = getGlobalInstallSource(name)
  const sourceType: DepDisplayInfo['sourceType'] = (installSource?.source as DepDisplayInfo['sourceType']) ?? 'unknown'
  const gitInfo = dep.localPath ? getLocalGitInfo(dep.localPath) : null
  const version = sourceType !== 'local' ? (getGlobalInstalledVersion(name) ?? undefined) : undefined

  return {
    name,
    currentSource: installSource?.source ?? '(not installed)',
    currentSpecifier: installSource?.specifier,
    sourceType,
    isGlobal: true,
    version,
    gitInfo,
    config: dep,
  }
}

export function buildProjectDepInfo(
  name: string,
  dep: DepConfig,
  projectRoot: string,
  pkg: Record<string, unknown>,
  overrides?: Record<string, string>,
): DepDisplayInfo {
  // override-managed deps draw their active source from pnpm.overrides, not the
  // (static baseline) package.json dep spec.
  const currentSource = (dep.override ? overrides?.[name] : undefined) ?? getCurrentSource(pkg, name)
  const sourceType = getSourceType(currentSource)
  const devDeps = pkg.devDependencies as Record<string, string> | undefined
  const isDev = !!(devDeps && name in devDeps)

  const version = sourceType !== 'local' ? (getInstalledVersion(projectRoot, name) ?? undefined) : undefined
  const gitInfo = dep.localPath ? getLocalGitInfo(resolve(projectRoot, dep.localPath)) : null

  const committedPkg = dep.override ? null : getCommittedPackageJson(projectRoot)
  const committedSrc = committedPkg ? getCurrentSource(committedPkg, name) : undefined
  const committedSource = committedSrc && committedSrc !== currentSource && committedSrc !== '(not found)'
    ? committedSrc : undefined

  return {
    name,
    currentSource,
    sourceType,
    isDev,
    version,
    gitInfo,
    committedSource,
    config: dep,
  }
}

export async function buildGlobalDepInfoAsync(
  name: string,
  dep: DepConfig,
  globalSources: Map<string, { source: string; specifier: string }>,
): Promise<DepDisplayInfo> {
  const installSource = globalSources.get(name) ?? null
  const sourceType: DepDisplayInfo['sourceType'] = (installSource?.source as DepDisplayInfo['sourceType']) ?? 'unknown'
  const gitInfo = dep.localPath ? await getLocalGitInfoAsync(dep.localPath) : null
  const version = sourceType !== 'local' ? (getGlobalInstalledVersion(name) ?? undefined) : undefined

  return {
    name,
    currentSource: installSource?.source ?? '(not installed)',
    currentSpecifier: installSource?.specifier,
    sourceType,
    isGlobal: true,
    version,
    gitInfo,
    config: dep,
  }
}

export async function buildProjectDepInfoAsync(
  name: string,
  dep: DepConfig,
  projectRoot: string,
  pkg: Record<string, unknown>,
  overrides?: Record<string, string>,
): Promise<DepDisplayInfo> {
  // override-managed deps draw their active source from pnpm.overrides, not the
  // (static baseline) package.json dep spec.
  const currentSource = (dep.override ? overrides?.[name] : undefined) ?? getCurrentSource(pkg, name)
  const sourceType = getSourceType(currentSource)
  const devDeps = pkg.devDependencies as Record<string, string> | undefined
  const isDev = !!(devDeps && name in devDeps)

  const version = sourceType !== 'local' ? (getInstalledVersion(projectRoot, name) ?? undefined) : undefined
  const gitInfo = dep.localPath ? await getLocalGitInfoAsync(resolve(projectRoot, dep.localPath)) : null

  // Check if the dep specifier differs from what's committed
  // Check if the dep specifier differs from what's committed
  const committedPkg = dep.override ? null : getCommittedPackageJson(projectRoot)
  const committedSrc = committedPkg ? getCurrentSource(committedPkg, name) : undefined
  const committedSource = committedSrc && committedSrc !== currentSource && committedSrc !== '(not found)'
    ? committedSrc : undefined

  return {
    name,
    currentSource,
    sourceType,
    isDev,
    version,
    gitInfo,
    committedSource,
    config: dep,
  }
}

export async function fetchRemoteVersionsAsync(
  dep: DepConfig,
  depName: string,
  localPath?: string,
  pinnedVersion?: string,
  committedSource?: string,
): Promise<RemoteVersions> {
  const distBranch = dep.distBranch ?? 'dist'
  const npmName = dep.npm ?? depName

  // Extract the committed dist SHA if it differs from current
  const committedDistSha = committedSource ? extractSourceSha(committedSource) : undefined

  function catchLog<T>(label: string, p: Promise<T>): Promise<T | undefined> {
    return p.catch((err) => {
      log.debug(`${depName}: ${label}: ${err instanceof Error ? err.message : err}`)
      return undefined
    })
  }
  const [npmInfo, ghSha, ghPkg, glSha, glPkg, committedPkg] = await Promise.all([
    getNpmInfoAsync(npmName),
    dep.github ? catchLog('GitHub ref', resolveGitHubRefAsync(dep.github, distBranch)) : undefined,
    dep.github ? catchLog('GitHub pkg', fetchGitHubPackageJsonAsync(dep.github, distBranch)) : undefined,
    dep.gitlab ? catchLog('GitLab ref', resolveGitLabRefAsync(dep.gitlab, distBranch)) : undefined,
    dep.gitlab ? catchLog('GitLab pkg', fetchGitLabPackageJsonAsync(dep.gitlab, distBranch)) : undefined,
    // Fetch package.json from the committed dist SHA to get its version/source info
    committedDistSha && dep.github
      ? catchLog('GitHub committed pkg', fetchGitHubPackageJsonAsync(dep.github, committedDistSha))
      : committedDistSha && dep.gitlab
        ? catchLog('GitLab committed pkg', fetchGitLabPackageJsonAsync(dep.gitlab, committedDistSha))
        : undefined,
  ])
  const npmVersion = npmInfo?.version

  const latestDistVersion = (ghPkg?.version ?? glPkg?.version) as string | undefined
  const latestDistSourceSha = latestDistVersion ? parseDistSourceSha(latestDistVersion) : undefined
  const rawPinnedSourceSha = pinnedVersion ? parseDistSourceSha(pinnedVersion) : undefined

  // Orphan detection: if the pinned dist's source SHA is not reachable in the
  // local repo (likely force-pushed away), flag it and fall back to the latest
  // dist source as the comparison ref so other deltas remain meaningful.
  let pinnedSrcMissing = false
  let pinnedSourceSha = rawPinnedSourceSha
  if (localPath && rawPinnedSourceSha) {
    const reachable = await isCommitReachableAsync(localPath, rawPinnedSourceSha)
    if (!reachable) {
      log.info(`${depName}: pinned source ${rawPinnedSourceSha} not reachable in ${localPath} (likely force-pushed or garbage-collected)`)
      pinnedSrcMissing = true
      pinnedSourceSha = undefined
    }
  }

  let localAheadOfPinned: number | undefined
  let distAheadOfPinned: number | undefined
  let pinnedAheadOfDist: number | undefined
  // Compare local HEAD against the reference SHA: pinned source SHA if available,
  // otherwise latest dist source SHA (e.g. when dep is in local mode)
  const refSha = pinnedSourceSha ?? latestDistSourceSha
  if (localPath && refSha) {
    log.debug(`${depName}: comparing local=${localPath} refSha=${refSha} distSrc=${latestDistSourceSha} pinnedSrc=${pinnedSourceSha}`)
    const [localAhead, distAhead, pinnedAhead] = await Promise.all([
      gitRevListCountAsync(localPath, refSha, 'HEAD').catch((e) => { log.debug(`${depName}: rev-list local: ${e}`); return null }),
      latestDistSourceSha && latestDistSourceSha !== refSha
        ? gitRevListCountAsync(localPath, refSha, latestDistSourceSha).catch((e) => { log.debug(`${depName}: rev-list dist: ${e}`); return null })
        : null,
      latestDistSourceSha && latestDistSourceSha !== refSha
        ? gitRevListCountAsync(localPath, latestDistSourceSha, refSha).catch((e) => { log.debug(`${depName}: rev-list pinned: ${e}`); return null })
        : null,
    ])
    if (localAhead && localAhead > 0) localAheadOfPinned = localAhead
    if (distAhead && distAhead > 0) distAheadOfPinned = distAhead
    if (pinnedAhead && pinnedAhead > 0) pinnedAheadOfDist = pinnedAhead
  }

  // Find the source SHA that the latest npm version corresponds to.
  // First try: dist version's base matches npm version → use dist's source SHA
  // Fallback: resolve npm version as a git tag in the local repo (e.g. v3.4.0)
  let npmSourceSha: string | undefined
  if (npmVersion && latestDistVersion && baseVersion(latestDistVersion) === npmVersion) {
    npmSourceSha = parseDistSourceSha(latestDistVersion)
    log.debug(`${depName}: npmSourceSha from dist (base matches npm=${npmVersion}): ${npmSourceSha}`)
  } else if (npmVersion && localPath) {
    const tagSha = await resolveVersionTagAsync(localPath, npmVersion)
    if (tagSha) {
      npmSourceSha = tagSha
      log.debug(`${depName}: npmSourceSha from local tag v${npmVersion}: ${tagSha}`)
    } else {
      log.debug(`${depName}: npmSourceSha unresolved (npm=${npmVersion}, no matching tag in ${localPath})`)
    }
  } else if (npmVersion) {
    log.debug(`${depName}: npmSourceSha unresolved (npm=${npmVersion}, no localPath for tag lookup)`)
  }

  // Compute commit distance between npm source and latest dist source
  const distRefSha = latestDistSourceSha ?? refSha
  let npmAheadOfDist: number | undefined
  let distAheadOfNpm: number | undefined
  if (localPath && npmSourceSha && distRefSha && npmSourceSha !== distRefSha
      && !npmSourceSha.startsWith(distRefSha) && !distRefSha.startsWith(npmSourceSha)) {
    log.debug(`${depName}: computing npm<->dist delta: npmSrc=${npmSourceSha} distRef=${distRefSha}`)
    const [npmAhead, distAhead] = await Promise.all([
      gitRevListCountAsync(localPath, distRefSha, npmSourceSha).catch((e) => { log.debug(`${depName}: rev-list npm-ahead: ${e}`); return null }),
      gitRevListCountAsync(localPath, npmSourceSha, distRefSha).catch((e) => { log.debug(`${depName}: rev-list dist-ahead-of-npm: ${e}`); return null }),
    ])
    if (npmAhead && npmAhead > 0) npmAheadOfDist = npmAhead
    if (distAhead && distAhead > 0) distAheadOfNpm = distAhead
  } else if (localPath && npmSourceSha && distRefSha) {
    log.debug(`${depName}: skipping npm<->dist delta (equal/prefix): npmSrc=${npmSourceSha} distRef=${distRefSha}`)
  }

  const committedDistVersion = committedPkg?.version as string | undefined

  return {
    npm: npmVersion,
    npmAheadOfDist,
    distAheadOfNpm,
    npmSourceSha,
    github: ghSha ? ghSha.slice(0, 7) : undefined,
    githubVersion: ghPkg?.version as string | undefined,
    gitlab: glSha ? glSha.slice(0, 7) : undefined,
    gitlabVersion: glPkg?.version as string | undefined,
    committedDistSha,
    committedDistVersion,
    localAheadOfPinned,
    distAheadOfPinned,
    pinnedAheadOfDist,
    pinnedSrcMissing: pinnedSrcMissing || undefined,
  }
}

// Fetch remote version info for a dependency (sync, for verbose listing)
export function fetchRemoteVersions(dep: DepConfig, depName: string): RemoteVersions {
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
