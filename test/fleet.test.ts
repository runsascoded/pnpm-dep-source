import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectFleet, listWorkspacePackages, readPdsHint } from '../src/fleet.js'

const TMP = join(__dirname, 'fixtures', 'fleet-mono')

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function pkg(dir: string, name: string, isPrivate = false): void {
  mkdirSync(join(TMP, dir), { recursive: true })
  writeJson(join(TMP, dir, 'package.json'), { name, version: '1.0.0', private: isPrivate })
}

// A monorepo root with packages/* (two publishable, one private) + a non-package dir.
function setup(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  mkdirSync(TMP, { recursive: true })
  writeJson(join(TMP, 'package.json'), { name: '@mono/root', private: true })
  writeFileSync(join(TMP, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  pkg('packages/cli', '@mono/cli')
  pkg('packages/core', '@mono/core')
  pkg('packages/internal', '@mono/internal', true) // private → excluded by auto-detect
  mkdirSync(join(TMP, 'packages/not-a-pkg'), { recursive: true }) // no package.json
}

describe('fleet detection', () => {
  beforeEach(setup)
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  it('listWorkspacePackages enumerates named packages (incl. private)', () => {
    const names = listWorkspacePackages(TMP)
      .map(p => p.name)
      .sort()
    expect(names).toEqual(['@mono/cli', '@mono/core', '@mono/internal'])
  })

  it('auto-detects publishable packages (excludes private), override strategy', () => {
    const fleet = detectFleet(TMP)
    expect(fleet).not.toBeNull()
    expect(fleet!.strategy).toBe('override')
    expect(fleet!.fromHint).toBe(false)
    expect(fleet!.members.map(m => m.npm).sort()).toEqual(['@mono/cli', '@mono/core'])
    const cli = fleet!.members.find(m => m.npm === '@mono/cli')!
    expect(cli.subdir).toBe('/packages/cli')
  })

  it('returns null for a plain package (no workspace, no hint)', () => {
    const plain = join(TMP, 'packages/cli')
    expect(detectFleet(plain)).toBeNull()
  })

  it('a pds.json hint narrows the fleet to its declared list', () => {
    writeJson(join(TMP, 'pds.json'), { strategy: 'override', fleet: ['@mono/cli'] })
    const fleet = detectFleet(TMP)!
    expect(fleet.fromHint).toBe(true)
    expect(fleet.members.map(m => m.npm)).toEqual(['@mono/cli'])
  })

  it('a hint fleet may include an otherwise-excluded private package', () => {
    writeJson(join(TMP, 'pds.json'), { fleet: ['@mono/internal'] })
    const fleet = detectFleet(TMP)!
    expect(fleet.members.map(m => m.npm)).toEqual(['@mono/internal'])
    // single declared member → default strategy unless the hint says otherwise
    expect(fleet.strategy).toBe('default')
  })

  it('readPdsHint reads a package.json#pds key when no pds.json exists', () => {
    writeJson(join(TMP, 'package.json'), {
      name: '@mono/root',
      private: true,
      pds: { strategy: 'override', fleet: ['@mono/core'] },
    })
    expect(readPdsHint(TMP)).toEqual({ strategy: 'override', fleet: ['@mono/core'] })
  })

  it('honors a workspaces field in package.json (npm/yarn style)', () => {
    rmSync(join(TMP, 'pnpm-workspace.yaml'))
    writeJson(join(TMP, 'package.json'), { name: '@mono/root', private: true, workspaces: ['packages/*'] })
    const fleet = detectFleet(TMP)!
    expect(fleet.members.map(m => m.npm).sort()).toEqual(['@mono/cli', '@mono/core'])
  })
})
