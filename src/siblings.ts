import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

import { listWorkspacePackages } from './fleet.js'
import { log } from './log.js'
import { loadPackageJson } from './pkg.js'
import type { Config } from './types.js'

// Detect `package.json` deps that come from the same repo as a registered dep
// but aren't themselves registered — a config built by `init`-ing individual
// package paths instead of the monorepo root. Such a fleet is only half-swapped
// by `pds l -a` etc., yet still installs and runs, so warn.
//
// Local-only (no network): siblings are found from registered deps' `localPath`s,
// either as packages of an enclosing workspace (the same expansion `init
// <monorepo-root>` uses) or as package dirs sharing the dep's parent dir, in both
// cases within the dep's git repo.

export interface UnregisteredSibling {
  /** The unregistered `package.json` dependency. */
  name: string
  /** Its package directory (absolute). */
  dir: string
  /** The repo it shares with registered deps: `github`/`gitlab` slug, else the repo's local path. */
  repo: string
  /** Registered deps from the same repo, sorted. */
  registered: string[]
  /** Workspace root enclosing the siblings, if any (for `pds init <monorepo-root>`). */
  monorepoRoot?: string
}

function gitRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return null
  }
}

function packageName(dir: string): string | null {
  try {
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

// Nearest workspace root at or above `dir`, not leaving the repo at `root`.
function enclosingWorkspace(dir: string, root: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (listWorkspacePackages(d).length > 0) return d
    if (d === root || dirname(d) === d) return null
  }
}

interface RepoGroup {
  root: string
  slug?: string
  registered: Set<string>
  candidates: Map<string, string>  // package name → dir
  monorepoRoot?: string
}

export function findUnregisteredSiblings(
  projectRoot: string,
  config: Config,
  pkg: Record<string, unknown>,
): UnregisteredSibling[] {
  const depNames = new Set([
    ...Object.keys((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...Object.keys((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  ])
  const registered = new Set<string>()
  for (const [name, dc] of Object.entries(config.dependencies)) {
    registered.add(name)
    if (dc.npm) registered.add(dc.npm)
  }
  // Packages in the consumer's own repo are its workspace, not an external fleet.
  const projectRepo = gitRoot(resolve(projectRoot))

  const groups = new Map<string, RepoGroup>()
  for (const [name, dc] of Object.entries(config.dependencies)) {
    if (!dc.localPath) continue
    const dir = resolve(projectRoot, dc.localPath)
    if (!existsSync(join(dir, 'package.json'))) continue
    const root = gitRoot(dir)
    if (!root || root === projectRepo) continue

    let group = groups.get(root)
    if (!group) {
      group = { root, registered: new Set(), candidates: new Map() }
      groups.set(root, group)
    }
    group.registered.add(name)
    group.slug ??= dc.github ?? dc.gitlab

    const ws = enclosingWorkspace(dir, root)
    if (ws) {
      group.monorepoRoot ??= ws
      for (const p of listWorkspacePackages(ws)) group.candidates.set(p.name, p.dir)
    }
    if (dir !== root) {
      const parent = dirname(dir)
      let entries: string[] = []
      try {
        entries = readdirSync(parent)
      } catch {}
      for (const e of entries) {
        const sib = join(parent, e)
        const sibName = packageName(sib)
        if (sibName && !group.candidates.has(sibName)) group.candidates.set(sibName, sib)
      }
    }
  }

  const out: UnregisteredSibling[] = []
  for (const group of groups.values()) {
    for (const [name, dir] of group.candidates) {
      if (!depNames.has(name) || registered.has(name)) continue
      out.push({
        name,
        dir,
        repo: group.slug ?? group.root,
        registered: [...group.registered].sort(),
        ...(group.monorepoRoot ? { monorepoRoot: group.monorepoRoot } : {}),
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// Paths in the suggested commands are relative to cwd (where `pds init` resolves them).
export function formatSiblingWarning(s: UnregisteredSibling, cwd: string = process.cwd()): string {
  const rel = (p: string) => relative(cwd, p) || '.'
  const repo = isAbsolute(s.repo) ? rel(s.repo) : s.repo
  const lines = [
    `${s.name} is a dependency but isn't managed by pds, and comes from ${repo} (same repo as: ${s.registered.join(', ')}).`,
    `  Register it:  pds init ${rel(s.dir)}`,
  ]
  if (s.monorepoRoot) lines.push(`  Or the fleet: pds init ${rel(s.monorepoRoot)}`)
  return lines.join('\n')
}

let warned = false

/** Warn (stderr, once per process) about unregistered repo siblings. Never throws. */
export function warnUnregisteredSiblings(projectRoot: string, config: Config): void {
  if (warned) return
  warned = true
  let found: UnregisteredSibling[]
  try {
    found = findUnregisteredSiblings(projectRoot, config, loadPackageJson(projectRoot))
  } catch (e) {
    log.debug(`sibling check failed: ${(e as Error).message}`)
    return
  }
  for (const s of found) log.warn(formatSiblingWarning(s))
}
