import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DepConfig } from '../src/types.js'
import { switchToLocal, switchToGitHub, switchToPkgPrNew, switchToNpm, cleanupDepReferences } from '../src/switch.js'

const TMP = join(__dirname, 'fixtures', 'switch-cr')
const DEP_NAME = '@test/mock-dep'
const DEP: DepConfig = {
  localPath: '../mock-dep',
  github: 'test-org/mock-dep',
  npm: '@test/mock-dep',
  distBranch: 'dist',
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function setup(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(
    join(TMP, 'package.json'),
    JSON.stringify({ name: 'host', version: '1.0.0', dependencies: { [DEP_NAME]: '^1.0.0' } }, null, 2) + '\n',
  )
  writeFileSync(
    join(TMP, 'vite.config.ts'),
    `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [],\n})\n`,
  )
}

describe('switchToPkgPrNew', () => {
  beforeEach(setup)
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  it('sets the SHA-pinned pkg.pr.new URL in package.json', () => {
    switchToPkgPrNew(TMP, DEP_NAME, DEP, 'abcdef1234567')

    const pkg = readJson(join(TMP, 'package.json'))
    expect((pkg.dependencies as Record<string, string>)[DEP_NAME]).toBe(
      'https://pkg.pr.new/test-org/mock-dep/@test/mock-dep@abcdef1234567',
    )
  })

  it('local → cr round-trip drops the dep from pnpm-workspace.yaml and vite optimizeDeps', () => {
    const viteOriginal = readFileSync(join(TMP, 'vite.config.ts'), 'utf-8')

    // Local mode adds workspace + vite entries
    switchToLocal(TMP, DEP_NAME, DEP)
    expect(existsSync(join(TMP, 'pnpm-workspace.yaml'))).toBe(true)
    expect(readFileSync(join(TMP, 'vite.config.ts'), 'utf-8')).toContain(`'${DEP_NAME}'`)

    // Switching to cr removes them
    switchToPkgPrNew(TMP, DEP_NAME, DEP, 'abcdef1234567')
    expect(existsSync(join(TMP, 'pnpm-workspace.yaml'))).toBe(false)
    expect(readFileSync(join(TMP, 'vite.config.ts'), 'utf-8')).toBe(viteOriginal)
  })

  it('handles a transitive dep (tracked but not a direct dependency)', () => {
    // package.json has only @test/other; @test/mock-dep is tracked in .pds.json
    // but is a transitive dep here (not in package.json).
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ name: 'host', version: '1.0.0', dependencies: { '@test/other': '^1.0.0' } }, null, 2) + '\n',
    )
    // Seed a workspace entry for the transitive dep (as `pds l` would have left it)
    writeFileSync(join(TMP, 'pnpm-workspace.yaml'), 'packages:\n  - ../mock-dep\n')

    // Should NOT throw; rewrites no package.json entry but cleans the workspace
    switchToPkgPrNew(TMP, DEP_NAME, DEP, 'abcdef1234567')

    const pkg = readJson(join(TMP, 'package.json'))
    expect(pkg.dependencies).toEqual({ '@test/other': '^1.0.0' }) // unchanged
    expect(existsSync(join(TMP, 'pnpm-workspace.yaml'))).toBe(false) // workspace entry dropped
  })

  it('switchToNpm round-trips a direct dep', () => {
    switchToNpm(TMP, DEP_NAME, DEP, '^2.0.0')
    const pkg = readJson(join(TMP, 'package.json'))
    expect((pkg.dependencies as Record<string, string>)[DEP_NAME]).toBe('^2.0.0')
  })

  it('throws when github is not configured', () => {
    expect(() => switchToPkgPrNew(TMP, DEP_NAME, { npm: '@test/mock-dep' }, 'abc')).toThrow(
      /No GitHub repo configured/,
    )
  })

  it('throws when npm package name is not configured', () => {
    expect(() => switchToPkgPrNew(TMP, DEP_NAME, { github: 'test-org/mock-dep' }, 'abc')).toThrow(
      /No npm package name configured/,
    )
  })
})

describe('override strategy (pnpm.overrides)', () => {
  const OV: DepConfig = { ...DEP, override: true }
  beforeEach(setup)
  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true })
  })

  // The package.json dep spec, pnpm-workspace.yaml, and vite.config.ts are the
  // "baseline" and must stay byte-identical through every override switch.
  function assertBaselineUntouched(viteOriginal: string): void {
    const pkg = readJson(join(TMP, 'package.json'))
    expect(pkg.dependencies).toEqual({ [DEP_NAME]: '^1.0.0' })
    expect(existsSync(join(TMP, 'pnpm-workspace.yaml'))).toBe(false)
    expect(readFileSync(join(TMP, 'vite.config.ts'), 'utf-8')).toBe(viteOriginal)
  }

  it('local writes a link: override, leaving the baseline untouched', () => {
    const viteOriginal = readFileSync(join(TMP, 'vite.config.ts'), 'utf-8')
    switchToLocal(TMP, DEP_NAME, OV)
    const pkg = readJson(join(TMP, 'package.json'))
    expect((pkg.pnpm as { overrides: Record<string, string> }).overrides).toEqual({
      [DEP_NAME]: 'link:../mock-dep',
    })
    assertBaselineUntouched(viteOriginal)
  })

  it('cr writes a pkg.pr.new override', () => {
    switchToPkgPrNew(TMP, DEP_NAME, OV, 'abcdef1234567')
    const pkg = readJson(join(TMP, 'package.json'))
    expect((pkg.pnpm as { overrides: Record<string, string> }).overrides).toEqual({
      [DEP_NAME]: 'https://pkg.pr.new/test-org/mock-dep/@test/mock-dep@abcdef1234567',
    })
  })

  it('github writes a tarball-URL override', () => {
    switchToGitHub(TMP, DEP_NAME, OV, 'abcdef1234567')
    const pkg = readJson(join(TMP, 'package.json'))
    expect((pkg.pnpm as { overrides: Record<string, string> }).overrides).toEqual({
      [DEP_NAME]: 'https://github.com/test-org/mock-dep#abcdef1234567',
    })
  })

  it('npm writes a version override', () => {
    switchToNpm(TMP, DEP_NAME, OV, '^2.0.0')
    const pkg = readJson(join(TMP, 'package.json'))
    expect((pkg.pnpm as { overrides: Record<string, string> }).overrides).toEqual({
      [DEP_NAME]: '^2.0.0',
    })
  })

  it('round-trips local → cr → npm by rewriting only the single override entry', () => {
    const viteOriginal = readFileSync(join(TMP, 'vite.config.ts'), 'utf-8')
    const overridesOf = () =>
      (readJson(join(TMP, 'package.json')).pnpm as { overrides: Record<string, string> }).overrides

    switchToLocal(TMP, DEP_NAME, OV)
    expect(overridesOf()).toEqual({ [DEP_NAME]: 'link:../mock-dep' })

    switchToPkgPrNew(TMP, DEP_NAME, OV, 'abcdef1234567')
    expect(overridesOf()).toEqual({
      [DEP_NAME]: 'https://pkg.pr.new/test-org/mock-dep/@test/mock-dep@abcdef1234567',
    })

    switchToNpm(TMP, DEP_NAME, OV, '^2.0.0')
    expect(overridesOf()).toEqual({ [DEP_NAME]: '^2.0.0' })

    assertBaselineUntouched(viteOriginal)
  })

  it('writes an override for a transitive dep not in package.json', () => {
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ name: 'host', version: '1.0.0', dependencies: { '@test/other': '^1.0.0' } }, null, 2) + '\n',
    )
    switchToLocal(TMP, DEP_NAME, OV)
    const pkg = readJson(join(TMP, 'package.json'))
    expect(pkg.dependencies).toEqual({ '@test/other': '^1.0.0' }) // unchanged
    expect((pkg.pnpm as { overrides: Record<string, string> }).overrides).toEqual({
      [DEP_NAME]: 'link:../mock-dep',
    })
  })

  it('cleanupDepReferences drops the override entry (and empty pnpm block)', () => {
    switchToPkgPrNew(TMP, DEP_NAME, OV, 'abcdef1234567')
    cleanupDepReferences(TMP, DEP_NAME, OV)
    const pkg = readJson(join(TMP, 'package.json'))
    expect('pnpm' in pkg).toBe(false)
    expect(pkg.dependencies).toEqual({ [DEP_NAME]: '^1.0.0' }) // baseline intact
  })

  it('preserves sibling overrides when cleaning one up', () => {
    switchToPkgPrNew(TMP, DEP_NAME, OV, 'abcdef1234567')
    switchToLocal(TMP, '@test/sibling', { ...OV, localPath: '../sibling' })
    cleanupDepReferences(TMP, DEP_NAME, OV)
    const pkg = readJson(join(TMP, 'package.json'))
    expect((pkg.pnpm as { overrides: Record<string, string> }).overrides).toEqual({
      '@test/sibling': 'link:../sibling',
    })
  })
})
