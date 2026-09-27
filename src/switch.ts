import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import type { DepConfig } from './types.js'
import { c } from './constants.js'
import {
  loadPackageJson, savePackageJson,
  updatePackageJsonDep, setPnpmOverride, removePnpmOverride, hasDependency,
  loadWorkspaceYaml, saveWorkspaceYaml,
} from './pkg.js'
import { resolveGitHubRef, resolveGitLabRef } from './remote.js'
import { workspaceLocalPath } from './project.js'
import { log } from './log.js'
import { addOptimizeDepsExclude, removeOptimizeDepsExclude } from './vite-config.js'

// pnpm.overrides live at the workspace root (the dir holding pnpm-workspace.yaml,
// or the single-package project root). `override`-managed deps force the WHOLE
// graph — including transitive monorepo siblings — to a single source, which the
// per-dependency package.json-rewrite strategy can't do.
function overrideRoot(projectRoot: string, workspaceRoot?: string | null): string {
  return workspaceRoot ?? projectRoot
}

// Write (or, with `specifier === null`, remove) a pnpm.overrides entry.
function applyOverride(root: string, depName: string, specifier: string | null): void {
  const pkg = loadPackageJson(root)
  if (specifier === null) removePnpmOverride(pkg, depName)
  else setPnpmOverride(pkg, depName, specifier)
  savePackageJson(root, pkg)
}

// `link:<path>` specifier for an override-managed local dep. localPath is relative
// to projectRoot; the override is declared at `root`, so re-relativize.
export function makeLinkSpecifier(projectRoot: string, root: string, localPath: string): string {
  return `link:${relative(root, resolve(projectRoot, localPath))}`
}

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']

// Add/remove `depName` in `optimizeDeps.exclude` (local deps must be excluded
// from pre-bundling so edits hot-reload). See `vite-config.ts`.
export function updateViteConfig(projectRoot: string, depName: string, exclude: boolean): void {
  const name = VITE_CONFIGS.find(f => existsSync(join(projectRoot, f)))
  if (!name) return
  const vitePath = join(projectRoot, name)
  const content = readFileSync(vitePath, 'utf-8')
  const result = exclude
    ? addOptimizeDepsExclude(content, depName)
    : removeOptimizeDepsExclude(content, depName)
  if (result.status === 'changed') {
    writeFileSync(vitePath, result.content)
  } else if (result.status === 'unsupported') {
    const verb = exclude ? `add '${depName}' to` : `remove '${depName}' from`
    log.warn(`${name}: couldn't ${verb} \`optimizeDeps.exclude\` (${result.reason}); edit it manually`)
  }
}

// Generate GitHub specifier using HTTPS tarball URL (avoids SSH auth issues in CI)
export function makeGitHubSpecifier(repo: string, ref: string, subdir?: string): string {
  if (subdir) {
    // pnpm git subdirectory syntax: #ref&path:/subdir
    return `https://github.com/${repo}#${ref}&path:${subdir}`
  }
  return `https://github.com/${repo}#${ref}`
}

// Generate a pkg.pr.new continuous-release URL: a raw HTTPS tarball-style
// specifier pnpm installs directly (mechanically like the GitLab tarball URL).
// Format: https://pkg.pr.new/<owner>/<repo>/<npmName>@<sha>
// `repo` is the GitHub "owner/repo"; `npm` is the package name (scope included).
export function makePkgPrNewSpecifier(repo: string, npm: string, sha: string): string {
  return `https://pkg.pr.new/${repo}/${npm}@${sha}`
}

// pds can track transitive deps of a monorepo fork (e.g. `@slidev/client` when
// only `@slidev/cli` is a direct dep). Those have no package.json entry to
// rewrite, but still need their workspace/override references managed. Apply the
// specifier when the dep is a direct dependency; always strip any pnpm override.
// Returns whether it was a direct dependency.
function applyPackageJsonSpecifier(projectRoot: string, depName: string, specifier: string): boolean {
  const pkg = loadPackageJson(projectRoot)
  const inPkg = hasDependency(pkg, depName)
  if (inPkg) updatePackageJsonDep(pkg, depName, specifier)
  removePnpmOverride(pkg, depName)
  savePackageJson(projectRoot, pkg)
  return inPkg
}

const transitiveNote = (inPkg: boolean): string =>
  inPkg ? '' : ' (transitive; package.json unchanged)'

// Helper to switch a dependency to local mode
export function switchToLocal(
  projectRoot: string,
  depName: string,
  depConfig: DepConfig,
  workspaceRoot?: string | null,
): void {
  const localPath = depConfig.localPath
  if (!localPath) {
    throw new Error(`No local path configured for ${depName}. Use "pds set ${depName} -l <path>" to set one.`)
  }

  if (depConfig.override) {
    const root = overrideRoot(projectRoot, workspaceRoot)
    const specifier = makeLinkSpecifier(projectRoot, root, localPath)
    applyOverride(root, depName, specifier)
    console.log(`Switched ${depName} to local (override): ${specifier}`)
    return
  }

  const pkg = loadPackageJson(projectRoot)
  const inPkg = hasDependency(pkg, depName)
  if (inPkg) {
    updatePackageJsonDep(pkg, depName, 'workspace:*')
    savePackageJson(projectRoot, pkg)
  }

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

  console.log(`Switched ${depName} to local: ${resolve(projectRoot, localPath)}${transitiveNote(inPkg)}`)
}

// Helper to switch a dependency to GitHub mode
export function switchToGitHub(
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

  if (depConfig.override) {
    const root = overrideRoot(projectRoot, workspaceRoot)
    applyOverride(root, depName, specifier)
    console.log(`Switched ${depName} to GitHub (override): ${specifier}`)
    return
  }

  const inPkg = applyPackageJsonSpecifier(projectRoot, depName, specifier)

  // Drop from pnpm-workspace.yaml + vite optimizeDeps.exclude
  cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot)

  console.log(`Switched ${depName} to GitHub: ${specifier}${transitiveNote(inPkg)}`)
}

// Helper to switch a dependency to GitLab mode
export function switchToGitLab(
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

  if (depConfig.override) {
    const root = overrideRoot(projectRoot, workspaceRoot)
    applyOverride(root, depName, tarballUrl)
    console.log(`Switched ${depName} to GitLab (override): ${depConfig.gitlab}@${resolvedRef}`)
    return
  }

  const inPkg = applyPackageJsonSpecifier(projectRoot, depName, tarballUrl)

  // Drop from pnpm-workspace.yaml + vite optimizeDeps.exclude
  cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot)

  console.log(`Switched ${depName} to GitLab: ${depConfig.gitlab}@${resolvedRef}${transitiveNote(inPkg)}`)
}

// Helper to switch a dependency to pkg.pr.new mode (SHA-pinned continuous release)
export function switchToPkgPrNew(
  projectRoot: string,
  depName: string,
  depConfig: DepConfig,
  resolvedSha: string,
  workspaceRoot?: string | null,
): void {
  if (!depConfig.github) {
    throw new Error(`No GitHub repo configured for ${depName}`)
  }
  if (!depConfig.npm) {
    throw new Error(`No npm package name configured for ${depName}`)
  }

  const specifier = makePkgPrNewSpecifier(depConfig.github, depConfig.npm, resolvedSha)

  if (depConfig.override) {
    const root = overrideRoot(projectRoot, workspaceRoot)
    applyOverride(root, depName, specifier)
    console.log(`Switched ${depName} to pkg.pr.new (override): ${specifier}`)
    return
  }

  const inPkg = applyPackageJsonSpecifier(projectRoot, depName, specifier)

  // Drop from pnpm-workspace.yaml + vite optimizeDeps.exclude (same as gh/gl)
  cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot)

  console.log(`Switched ${depName} to pkg.pr.new: ${specifier}${transitiveNote(inPkg)}`)
}

// Helper to switch a dependency to NPM mode
export function switchToNpm(
  projectRoot: string,
  depName: string,
  depConfig: DepConfig,
  specifier: string,
  workspaceRoot?: string | null,
): void {
  if (depConfig.override) {
    // Pin the whole graph to the published version via override (symmetric with
    // the other override modes), rather than rewriting the package.json baseline.
    const root = overrideRoot(projectRoot, workspaceRoot)
    applyOverride(root, depName, specifier)
    console.log(`Switched ${depName} to NPM (override): ${specifier}`)
    return
  }

  const inPkg = applyPackageJsonSpecifier(projectRoot, depName, specifier)

  // Drop from pnpm-workspace.yaml + vite optimizeDeps.exclude
  cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot)

  console.log(`Switched ${depName} to NPM: ${specifier}${transitiveNote(inPkg)}`)
}

// Helper to clean up workspace/vite when removing a dep
export function cleanupDepReferences(projectRoot: string, depName: string, depConfig: DepConfig, workspaceRoot?: string | null): void {
  // Drop any pnpm.overrides entry for override-managed deps
  if (depConfig.override) {
    applyOverride(overrideRoot(projectRoot, workspaceRoot), depName, null)
  }

  // Clean up pnpm-workspace.yaml if the dep was in it
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

  // Clean up vite.config.ts
  updateViteConfig(projectRoot, depName, false)
}

export function runPnpmInstall(projectRoot: string, workspaceRoot?: string | null): void {
  const installDir = workspaceRoot ?? projectRoot
  console.log('Running pnpm install...')
  try {
    execSync('pnpm install', { cwd: installDir, stdio: 'inherit' })
  } catch {
    console.error(`${c.yellow}Warning: pnpm install failed (config changes were saved)${c.reset}`)
  }
}

export function runGlobalInstall(specifier: string): void {
  console.log(`Running pnpm add -g ${specifier}...`)
  execSync(`pnpm add -g ${specifier}`, { stdio: 'inherit' })
}
