import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
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
  const quoted = `'${depName}'`

  if (exclude) {
    // Add depName to optimizeDeps.exclude
    if (content.includes(quoted) && content.includes('optimizeDeps')) {
      // Check if already in exclude array
      const excludeMatch = content.match(/exclude:\s*\[([^\]]*)\]/s)
      if (excludeMatch && excludeMatch[1].includes(quoted)) return
    }

    // Detect indentation from the file (horizontal whitespace only)
    const indentMatch = content.match(/\n([ \t]+)\S/)
    const indent = indentMatch?.[1] ?? '  '
    const i2 = indent + indent

    // Try to insert into existing optimizeDeps block
    const existingOptRe = /(\boptimizeDeps:\s*\{[^}]*)(})/
    const existingOptMatch = content.match(existingOptRe)
    if (existingOptMatch) {
      // Has optimizeDeps but maybe no exclude, or exclude without this dep
      const existingExcludeRe = /(exclude:\s*\[)([^\]]*)(])/s
      const innerMatch = existingOptMatch[0].match(existingExcludeRe)
      if (innerMatch) {
        // Add to existing exclude array
        if (innerMatch[2].includes(quoted)) return
        const items = innerMatch[2].trim()
        const newItems = items ? `${items}, ${quoted}` : quoted
        const updated = content.replace(existingExcludeRe, `$1${newItems}$3`)
        writeFileSync(vitePath, updated)
      } else {
        // Has optimizeDeps but no exclude — add exclude inside it
        const updated = content.replace(existingOptRe, `$1${i2}exclude: [${quoted}],\n${indent}$2`)
        writeFileSync(vitePath, updated)
      }
      return
    }

    // No optimizeDeps block — insert before the closing `})` or `}`
    // Match the last closing: newline, optional indent, `}` optionally followed by `)`
    const closingRe = /\n([ \t]*)(}\)?\s*)$/
    const closingMatch = content.match(closingRe)
    if (closingMatch) {
      const excludeBlock = `${indent}optimizeDeps: {\n${i2}exclude: [${quoted}],\n${indent}},`
      // Ensure the previous property has a trailing comma
      let updated = content
      const lastPropRe = /([^\s,])([ \t]*\n[ \t]*}\)?\s*)$/
      updated = updated.replace(lastPropRe, '$1,$2')
      updated = updated.replace(closingRe, `\n${excludeBlock}\n$1$2`)
      writeFileSync(vitePath, updated)
    }
  } else {
    // Remove depName from optimizeDeps.exclude
    if (!content.includes('optimizeDeps')) return

    let updated = content

    // Remove the entry from the exclude array
    const excludeRe = /exclude:\s*\[([^\]]*)\]/s
    const excludeMatch = updated.match(excludeRe)
    if (!excludeMatch) return
    if (!excludeMatch[1].includes(quoted)) return

    // Remove the dep from the array
    const items = excludeMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s && s !== quoted)

    if (items.length > 0) {
      // Other items remain
      updated = updated.replace(excludeRe, `exclude: [${items.join(', ')}]`)
    } else {
      // exclude array is now empty — remove the entire optimizeDeps block
      // Match the property line through closing `},` at the same indent level
      const indentMatch = updated.match(/\n([ \t]*)optimizeDeps:/)
      if (indentMatch) {
        const propIndent = indentMatch[1]
        const blockRe = new RegExp(
          `\\n${propIndent}optimizeDeps:\\s*\\{[\\s\\S]*?\\n${propIndent}\\},?\\n?`,
        )
        updated = updated.replace(blockRe, '\n')
        // Check if the now-last property has a trailing comma we should remove.
        // We added a comma during insertion if the file didn't use trailing commas
        // on its last property. Detect by checking: does the now-last line before
        // `})` end with `,`, and would removing it leave a `}` or `]` (i.e., the
        // comma was after a closing bracket, not inline like `foo: 1,`)?
        // Simple heuristic: if the file's last property ends with `},` or `],`
        // before `})`, check if all OTHER properties at this level also end with
        // `,`. If not, this trailing comma was likely added by us.
        const propEndRe = new RegExp(`^${propIndent}(\\S.*?)\\s*$`, 'gm')
        const propEndings: boolean[] = []
        let m
        while ((m = propEndRe.exec(updated)) !== null) {
          if (m[1].startsWith('optimizeDeps')) continue
          propEndings.push(m[1].endsWith(','))
        }
        // If the last entry is true (has comma) but most others are false,
        // it was likely added by us. More precisely: if it's the only one
        // without a matching style, remove it.
        if (propEndings.length > 0) {
          const lastHasComma = propEndings[propEndings.length - 1]
          const othersWithComma = propEndings.slice(0, -1).filter(Boolean).length
          const othersWithout = propEndings.slice(0, -1).filter(x => !x).length
          if (lastHasComma && othersWithout > 0 && othersWithComma <= othersWithout) {
            updated = updated.replace(/,([ \t]*\n[ \t]*}\)?\s*$)/, '$1')
          }
        }
      }
    }

    if (updated !== content) {
      writeFileSync(vitePath, updated)
    }
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
