import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { parseModule } from 'magicast'

import type { DepConfig } from './types.js'
import { c } from './constants.js'
import {
  loadPackageJson, savePackageJson,
  updatePackageJsonDep, removePnpmOverride,
  loadWorkspaceYaml, saveWorkspaceYaml,
} from './pkg.js'
import { resolveGitHubRef, resolveGitLabRef } from './remote.js'
import { workspaceLocalPath } from './project.js'

export function updateViteConfig(projectRoot: string, depName: string, exclude: boolean): void {
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

// Generate GitHub specifier using HTTPS tarball URL (avoids SSH auth issues in CI)
export function makeGitHubSpecifier(repo: string, ref: string, subdir?: string): string {
  if (subdir) {
    // pnpm git subdirectory syntax: #ref&path:/subdir
    return `https://github.com/${repo}#${ref}&path:${subdir}`
  }
  return `https://github.com/${repo}#${ref}`
}

// Helper to switch a dependency to local mode
export function switchToLocal(
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

  console.log(`Switched ${depName} to GitHub: ${specifier}`)
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
}

// Helper to clean up workspace/vite when removing a dep
export function cleanupDepReferences(projectRoot: string, depName: string, depConfig: DepConfig, workspaceRoot?: string | null): void {
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
