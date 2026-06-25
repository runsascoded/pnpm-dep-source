import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DepConfig } from '../src/types.js'
import { switchToLocal, switchToPkgPrNew } from '../src/switch.js'

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
    switchToLocal(TMP, DEP_NAME, DEP.localPath!)
    expect(existsSync(join(TMP, 'pnpm-workspace.yaml'))).toBe(true)
    expect(readFileSync(join(TMP, 'vite.config.ts'), 'utf-8')).toContain(`'${DEP_NAME}'`)

    // Switching to cr removes them
    switchToPkgPrNew(TMP, DEP_NAME, DEP, 'abcdef1234567')
    expect(existsSync(join(TMP, 'pnpm-workspace.yaml'))).toBe(false)
    expect(readFileSync(join(TMP, 'vite.config.ts'), 'utf-8')).toBe(viteOriginal)
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
