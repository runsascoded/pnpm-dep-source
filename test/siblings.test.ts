import { spawnSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findUnregisteredSiblings, formatSiblingWarning } from '../src/siblings.js'
import type { Config, DepConfig } from '../src/types.js'

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js')
const ROOT = join(__dirname, 'fixtures', 'siblings')
const CONSUMER = join(ROOT, 'consumer')
const PYRMTS = join(ROOT, 'pyrmts')
const pkgDir = (name: string) => join(PYRMTS, 'js', 'packages', name)

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

// A directory with a `.git` entry is a repo root, as far as sibling detection goes.
function repo(dir: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true })
}

function pkg(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  writeJson(join(dir, 'package.json'), { name, version: '1.0.0', ...extra })
}

const PYRMTS_DEP = (name: string): DepConfig => ({
  localPath: `../pyrmts/js/packages/${name}`,
  github: 'runsascoded/pyrmts',
  subdir: `/js/packages/${name}`,
})

const config = (deps: Record<string, DepConfig>): Config => ({ dependencies: deps })

const consumerPkg = (deps: string[]): Record<string, unknown> => ({
  name: 'consumer',
  dependencies: Object.fromEntries(deps.map(d => [d, '^1.0.0'])),
})

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  // Consumer: its own repo.
  repo(CONSUMER)
  // A monorepo publishing three packages under js/packages/.
  repo(PYRMTS)
  pkg(PYRMTS, 'pyrmts-root', { private: true })
  writeFileSync(join(PYRMTS, 'pnpm-workspace.yaml'), 'packages:\n  - js/packages/*\n')
  for (const n of ['pyrmts', 'pyrmts-cfw', 'pyrmts-geo']) pkg(pkgDir(n), n)
  // An unrelated single-package repo, next to the others.
  repo(join(ROOT, 'other'))
  pkg(join(ROOT, 'other'), 'other-lib')
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('findUnregisteredSiblings', () => {
  it('flags an unregistered dep from a registered dep\'s monorepo (the pyrmts case)', () => {
    const found = findUnregisteredSiblings(
      CONSUMER,
      config({ 'pyrmts': PYRMTS_DEP('pyrmts'), 'pyrmts-cfw': PYRMTS_DEP('pyrmts-cfw') }),
      consumerPkg(['pyrmts', 'pyrmts-cfw', 'pyrmts-geo', 'other-lib', 'react']),
    )
    expect(found).toEqual([{
      name: 'pyrmts-geo',
      dir: pkgDir('pyrmts-geo'),
      repo: 'runsascoded/pyrmts',
      registered: ['pyrmts', 'pyrmts-cfw'],
      monorepoRoot: PYRMTS,
    }])
  })

  it('also matches devDependencies', () => {
    const found = findUnregisteredSiblings(
      CONSUMER,
      config({ pyrmts: PYRMTS_DEP('pyrmts') }),
      { name: 'consumer', dependencies: { pyrmts: '^1' }, devDependencies: { 'pyrmts-cfw': '^1' } },
    )
    expect(found.map(s => s.name)).toEqual(['pyrmts-cfw'])
  })

  it('is silent when the whole fleet is registered', () => {
    expect(findUnregisteredSiblings(
      CONSUMER,
      config({ 'pyrmts': PYRMTS_DEP('pyrmts'), 'pyrmts-cfw': PYRMTS_DEP('pyrmts-cfw'), 'pyrmts-geo': PYRMTS_DEP('pyrmts-geo') }),
      consumerPkg(['pyrmts', 'pyrmts-cfw', 'pyrmts-geo', 'other-lib']),
    )).toEqual([])
  })

  it('is silent for siblings the consumer doesn\'t depend on', () => {
    expect(findUnregisteredSiblings(
      CONSUMER,
      config({ pyrmts: PYRMTS_DEP('pyrmts') }),
      consumerPkg(['pyrmts', 'other-lib']),
    )).toEqual([])
  })

  it('does not treat neighboring repos as siblings of a repo-root dep', () => {
    // `other/` is its own repo root; `pyrmts/` next to it is a different repo.
    expect(findUnregisteredSiblings(
      CONSUMER,
      config({ 'other-lib': { localPath: '../other', github: 'o/other' } }),
      consumerPkg(['other-lib', 'pyrmts', 'pyrmts-geo']),
    )).toEqual([])
  })

  it('finds shared-parent siblings in a repo without a workspace', () => {
    const plain = join(ROOT, 'plain')
    repo(plain)
    pkg(join(plain, 'pkgs', 'a'), '@p/a')
    pkg(join(plain, 'pkgs', 'b'), '@p/b')
    expect(findUnregisteredSiblings(
      CONSUMER,
      config({ '@p/a': { localPath: '../plain/pkgs/a' } }),
      consumerPkg(['@p/a', '@p/b']),
    )).toEqual([{ name: '@p/b', dir: join(plain, 'pkgs', 'b'), repo: plain, registered: ['@p/a'] }])
  })

  it('ignores packages from the consumer\'s own repo', () => {
    pkg(join(CONSUMER, 'packages', 'a'), '@c/a')
    pkg(join(CONSUMER, 'packages', 'b'), '@c/b')
    writeFileSync(join(CONSUMER, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    expect(findUnregisteredSiblings(
      CONSUMER,
      config({ '@c/a': { localPath: 'packages/a' } }),
      consumerPkg(['@c/a', '@c/b']),
    )).toEqual([])
  })

  it('skips registered deps whose localPath is missing', () => {
    expect(findUnregisteredSiblings(
      CONSUMER,
      config({ pyrmts: { localPath: '../nope/pyrmts', github: 'runsascoded/pyrmts' } }),
      consumerPkg(['pyrmts', 'pyrmts-geo']),
    )).toEqual([])
  })
})

describe('formatSiblingWarning', () => {
  it('names the repo and registered siblings, with cwd-relative init commands', () => {
    expect(formatSiblingWarning({
      name: 'pyrmts-geo',
      dir: pkgDir('pyrmts-geo'),
      repo: 'runsascoded/pyrmts',
      registered: ['pyrmts', 'pyrmts-cfw'],
      monorepoRoot: PYRMTS,
    }, CONSUMER).split('\n')).toEqual([
      'pyrmts-geo is a dependency but isn\'t managed by pds, and comes from runsascoded/pyrmts (same repo as: pyrmts, pyrmts-cfw).',
      '  Register it:  pds init ../pyrmts/js/packages/pyrmts-geo',
      '  Or the fleet: pds init ../pyrmts',
    ])
  })

  it('falls back to the repo\'s relative path, and omits the fleet line without a workspace', () => {
    const plain = join(ROOT, 'plain')
    expect(formatSiblingWarning({
      name: '@p/b',
      dir: join(plain, 'pkgs', 'b'),
      repo: plain,
      registered: ['@p/a'],
    }, CONSUMER).split('\n')).toEqual([
      '@p/b is a dependency but isn\'t managed by pds, and comes from ../plain (same repo as: @p/a).',
      '  Register it:  pds init ../plain/pkgs/b',
    ])
  })
})

describe('CLI', () => {
  const WARNING = [
    '[pds:warn] pyrmts-geo is a dependency but isn\'t managed by pds, and comes from runsascoded/pyrmts (same repo as: pyrmts, pyrmts-cfw).',
    '  Register it:  pds init ../pyrmts/js/packages/pyrmts-geo',
    '  Or the fleet: pds init ../pyrmts',
  ]

  function run(args: string[]) {
    const r = spawnSync('node', [CLI_PATH, ...args], {
      cwd: CONSUMER,
      encoding: 'utf-8',
      env: { ...process.env, PDS_LOG_LEVEL: 'warn' },
    })
    return { status: r.status, stderr: r.stderr.trimEnd().split('\n').filter(Boolean) }
  }

  function setupConsumer(registered: string[]): void {
    writeJson(join(CONSUMER, 'package.json'), consumerPkg(['pyrmts', 'pyrmts-cfw', 'pyrmts-geo']))
    writeJson(join(CONSUMER, '.pds.json'), config(Object.fromEntries(registered.map(n => [n, PYRMTS_DEP(n)]))))
  }

  it('`ls` warns on stderr, exit code unchanged', () => {
    setupConsumer(['pyrmts', 'pyrmts-cfw'])
    expect(run(['ls'])).toEqual({ status: 0, stderr: WARNING })
  })

  it('`local` warns once, before switching several deps', () => {
    setupConsumer(['pyrmts', 'pyrmts-cfw'])
    expect(run(['local', 'pyrmts', 'pyrmts-cfw', '-I'])).toEqual({ status: 0, stderr: WARNING })
  })

  it('is silent when the whole fleet is registered', () => {
    setupConsumer(['pyrmts', 'pyrmts-cfw', 'pyrmts-geo'])
    expect(run(['ls'])).toEqual({ status: 0, stderr: [] })
  })
})
