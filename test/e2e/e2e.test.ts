import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const TEST_PROJECT_DIR = '/test-project'
const MOCK_DEP_DIR = '/mock-dep'
const GLOBAL_CONFIG_DIR = join(homedir(), '.config', 'pnpm-dep-source')
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json')

function pds(args: string, cwd = TEST_PROJECT_DIR): string {
  return execSync(`pds ${args}`, { cwd, encoding: 'utf-8' })
}

function pnpm(args: string, cwd = TEST_PROJECT_DIR): string {
  return execSync(`pnpm ${args}`, { cwd, encoding: 'utf-8' })
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function writeJson(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function readYaml(path: string): string {
  return readFileSync(path, 'utf-8')
}

describe('e2e: global installs', () => {
  beforeAll(() => {
    // Clean up any existing global config
    if (existsSync(GLOBAL_CONFIG_FILE)) {
      rmSync(GLOBAL_CONFIG_FILE)
    }
  })

  afterAll(() => {
    if (existsSync(GLOBAL_CONFIG_FILE)) {
      rmSync(GLOBAL_CONFIG_FILE)
    }
  })

  it('pds --version returns version', () => {
    const output = pds('--version')
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('pds init -g creates global config', () => {
    pds(`init ${MOCK_DEP_DIR} -g -H test-org/mock-dep`)

    expect(existsSync(GLOBAL_CONFIG_FILE)).toBe(true)

    const config = readJson(GLOBAL_CONFIG_FILE)
    expect(config).toEqual({
      dependencies: {
        '@test/mock-dep': {
          localPath: '/mock-dep',
          github: 'test-org/mock-dep',
          npm: '@test/mock-dep',
          distBranch: 'dist',
        },
      },
    })
  })

  it('pds ls -g shows the dependency', () => {
    const output = pds('ls -g')
    expect(output).toContain('@test/mock-dep')
    expect(output).toContain('/mock-dep')
    expect(output).toContain('test-org/mock-dep')
  })

  it('pds l -g installs globally from local path', () => {
    pds('l -g')

    const listOutput = pnpm('list -g --json @test/mock-dep')
    const listData = JSON.parse(listOutput)
    expect(listData).toHaveLength(1)
    expect(listData[0].dependencies).toHaveProperty('@test/mock-dep')
  })

  it('pds status -g shows local source', () => {
    const output = pds('status -g')
    expect(output).toContain('@test/mock-dep')
    expect(output).toContain('local')
    expect(output).toContain('/mock-dep')
  })

  it('pds info shows install info', () => {
    const output = pds('info')
    expect(output).toContain('pnpm-dep-source')
    expect(output).toContain('binary:')
    expect(output).toContain('source:')
  })
})

describe('e2e: project-level installs', () => {
  const pkgPath = join(TEST_PROJECT_DIR, 'package.json')
  const configPath = join(TEST_PROJECT_DIR, '.pnpm-dep-source.json')
  const wsPath = join(TEST_PROJECT_DIR, 'pnpm-workspace.yaml')

  beforeEach(() => {
    // Clean up test project
    if (existsSync(pkgPath)) rmSync(pkgPath)
    if (existsSync(configPath)) rmSync(configPath)
    if (existsSync(wsPath)) rmSync(wsPath)

    // Create test project package.json
    writeJson(pkgPath, {
      name: 'test-project',
      version: '1.0.0',
      dependencies: {
        '@test/mock-dep': '^1.0.0',
      },
    })
  })

  afterEach(() => {
    if (existsSync(configPath)) rmSync(configPath)
    if (existsSync(wsPath)) rmSync(wsPath)
  })

  describe('init', () => {
    it('creates local config with correct structure', () => {
      pds(`init ${MOCK_DEP_DIR} -H test-org/mock-dep`)

      expect(existsSync(configPath)).toBe(true)

      const config = readJson(configPath)
      expect(config).toEqual({
        dependencies: {
          '@test/mock-dep': {
            localPath: '../mock-dep',
            github: 'test-org/mock-dep',
            npm: '@test/mock-dep',
            distBranch: 'dist',
          },
        },
      })
    })
  })

  describe('ls', () => {
    it('shows dependency info', () => {
      pds(`init ${MOCK_DEP_DIR} -H test-org/mock-dep`)
      const output = pds('ls')

      expect(output).toContain('@test/mock-dep')
      expect(output).toContain('Current: ^1.0.0')
      expect(output).toContain('../mock-dep')
      expect(output).toContain('test-org/mock-dep')
    })
  })

  describe('local', () => {
    beforeEach(() => {
      pds(`init ${MOCK_DEP_DIR} -H test-org/mock-dep`)
    })

    it('sets dependency to workspace:*', () => {
      pds('local -I')

      const pkg = readJson(pkgPath)
      expect(pkg.dependencies).toEqual({
        '@test/mock-dep': 'workspace:*',
      })
    })

    it('creates pnpm-workspace.yaml with correct content', () => {
      pds('local -I')

      expect(existsSync(wsPath)).toBe(true)
      const wsContent = readYaml(wsPath)
      expect(wsContent).toBe('packages:\n  - .\n  - ../mock-dep\n')
    })
  })

  describe('github', () => {
    beforeEach(() => {
      pds(`init ${MOCK_DEP_DIR} -H test-org/mock-dep`)
    })

    it('sets dependency to github ref', () => {
      pds('github main -I')

      const pkg = readJson(pkgPath)
      expect(pkg.dependencies).toEqual({
        '@test/mock-dep': 'github:test-org/mock-dep#main',
      })
    })

    it('removes pnpm-workspace.yaml when switching from local', () => {
      pds('local -I')
      expect(existsSync(wsPath)).toBe(true)

      pds('github main -I')
      expect(existsSync(wsPath)).toBe(false)
    })
  })

  describe('npm', () => {
    beforeEach(() => {
      pds(`init ${MOCK_DEP_DIR} -H test-org/mock-dep`)
    })

    it('sets dependency to npm version with caret', () => {
      pds('npm 2.0.0 -I')

      const pkg = readJson(pkgPath)
      expect(pkg.dependencies).toEqual({
        '@test/mock-dep': '^2.0.0',
      })
    })

    it('removes pnpm-workspace.yaml when switching from local', () => {
      pds('local -I')
      expect(existsSync(wsPath)).toBe(true)

      pds('npm 2.0.0 -I')
      expect(existsSync(wsPath)).toBe(false)
    })
  })

  describe('status', () => {
    beforeEach(() => {
      pds(`init ${MOCK_DEP_DIR} -H test-org/mock-dep`)
    })

    it('shows local status after switching to local', () => {
      pds('local -I')
      const output = pds('status')

      expect(output).toContain('@test/mock-dep')
      expect(output).toContain('local')
      expect(output).toContain('workspace:*')
    })

    it('shows github status after switching to github', () => {
      pds('github main -I')
      const output = pds('status')

      expect(output).toContain('@test/mock-dep')
      expect(output).toContain('github')
      expect(output).toContain('main')
    })

    it('shows npm status after switching to npm', () => {
      pds('npm 2.0.0 -I')
      const output = pds('status')

      expect(output).toContain('@test/mock-dep')
      expect(output).toContain('npm')
      expect(output).toContain('^2.0.0')
    })
  })

  describe('round-trips', () => {
    beforeEach(() => {
      pds(`init ${MOCK_DEP_DIR} -H test-org/mock-dep`)
    })

    it('local → github → local preserves state', () => {
      pds('local -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')
      expect(existsSync(wsPath)).toBe(true)

      pds('github main -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('github:test-org/mock-dep#main')
      expect(existsSync(wsPath)).toBe(false)

      pds('local -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')
      expect(existsSync(wsPath)).toBe(true)
    })

    it('local → npm → local preserves state', () => {
      pds('local -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')

      pds('npm 2.0.0 -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('^2.0.0')

      pds('local -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')
    })

    it('github → npm → github preserves state', () => {
      pds('github main -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('github:test-org/mock-dep#main')

      pds('npm 2.0.0 -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('^2.0.0')

      pds('github develop -I')
      expect((readJson(pkgPath).dependencies as Record<string, string>)['@test/mock-dep']).toBe('github:test-org/mock-dep#develop')
    })
  })
})
