import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js')
const TEST_DIR = join(__dirname, 'fixtures', 'test-project')
const MOCK_DEP_DIR = join(__dirname, 'fixtures', 'mock-dep')

function run(cmd: string, cwd = TEST_DIR): string {
  return execSync(`node ${CLI_PATH} ${cmd}`, { cwd, encoding: 'utf-8' })
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function writeJson(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function setupTestProject(): void {
  // Clean up any existing test project
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true })
  }
  mkdirSync(TEST_DIR, { recursive: true })

  // Create mock dependency directory with package.json
  if (!existsSync(MOCK_DEP_DIR)) {
    mkdirSync(MOCK_DEP_DIR, { recursive: true })
  }
  writeJson(join(MOCK_DEP_DIR, 'package.json'), {
    name: '@test/mock-dep',
    version: '1.0.0',
  })

  // Create test project package.json
  writeJson(join(TEST_DIR, 'package.json'), {
    name: 'test-project',
    version: '1.0.0',
    dependencies: {
      '@test/mock-dep': '^1.0.0',
    },
  })

  // Create .pnpm-dep-source.json config
  writeJson(join(TEST_DIR, '.pnpm-dep-source.json'), {
    dependencies: {
      '@test/mock-dep': {
        localPath: '../mock-dep',
        github: 'test-org/mock-dep',
        npm: '@test/mock-dep',
        distBranch: 'dist',
      },
    },
  })

  // Create vite.config.ts
  writeFileSync(
    join(TEST_DIR, 'vite.config.ts'),
    `import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [],
})
`
  )
}

describe('pds round-trips', () => {
  beforeEach(() => {
    setupTestProject()
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  describe('local mode', () => {
    it('sets workspace:* dependency and adds to pnpm-workspace.yaml', () => {
      run('local mock-dep -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')

      const wsPath = join(TEST_DIR, 'pnpm-workspace.yaml')
      expect(existsSync(wsPath)).toBe(true)
      const wsContent = readFileSync(wsPath, 'utf-8')
      expect(wsContent).toContain('../mock-dep')
    })

    it('adds dep to vite optimizeDeps.exclude', () => {
      run('local mock-dep -I')

      const viteConfig = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')
      expect(viteConfig).toContain("'@test/mock-dep'")
      expect(viteConfig).toContain('optimizeDeps')
      expect(viteConfig).toContain('exclude')
    })
  })

  describe('local → github round-trip', () => {
    it('cleans up pnpm-workspace.yaml', () => {
      run('local mock-dep -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(true)

      run('github mock-dep main -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)
    })

    it('cleans up pnpm.overrides', () => {
      // Manually add an override (simulating old state)
      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      pkg.pnpm = {
        overrides: {
          '@test/mock-dep': 'link:../mock-dep',
        },
      }
      writeJson(pkgPath, pkg)

      run('github mock-dep main -I')

      const updatedPkg = readJson(pkgPath)
      const pnpm = updatedPkg.pnpm as Record<string, unknown> | undefined
      expect(pnpm?.overrides).toBeUndefined()
    })

    it('cleans up vite.config.ts without spurious whitespace', () => {
      const viteOriginal = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')

      run('local mock-dep -I')
      run('github mock-dep main -I')

      const viteAfter = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')
      expect(viteAfter).toBe(viteOriginal)
    })
  })

  describe('local → npm round-trip', () => {
    it('cleans up pnpm-workspace.yaml', () => {
      run('local mock-dep -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(true)

      // Use explicit version to avoid npm registry lookup
      run('npm mock-dep 2.0.0 -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)
    })

    it('cleans up pnpm.overrides', () => {
      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      pkg.pnpm = {
        overrides: {
          '@test/mock-dep': 'link:../mock-dep',
        },
      }
      writeJson(pkgPath, pkg)

      run('npm mock-dep 2.0.0 -I')

      const updatedPkg = readJson(pkgPath)
      const pnpm = updatedPkg.pnpm as Record<string, unknown> | undefined
      expect(pnpm?.overrides).toBeUndefined()
    })

    it('cleans up vite.config.ts without spurious whitespace', () => {
      const viteOriginal = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')

      run('local mock-dep -I')
      run('npm mock-dep 2.0.0 -I')

      const viteAfter = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')
      expect(viteAfter).toBe(viteOriginal)
    })
  })

  describe('github → npm round-trip', () => {
    it('preserves clean state', () => {
      const pkgPath = join(TEST_DIR, 'package.json')

      run('github mock-dep main -I')
      const pkgAfterGh = readJson(pkgPath)
      expect((pkgAfterGh.dependencies as Record<string, string>)['@test/mock-dep']).toContain('github:')

      run('npm mock-dep 2.0.0 -I')
      const pkgAfterNpm = readJson(pkgPath)
      expect((pkgAfterNpm.dependencies as Record<string, string>)['@test/mock-dep']).toBe('^2.0.0')
    })
  })

  describe('github → local round-trip', () => {
    it('adds then removes workspace config', () => {
      run('github mock-dep main -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)

      run('local mock-dep -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(true)

      run('github mock-dep main -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)
    })
  })

  describe('npm → local round-trip', () => {
    it('adds then removes workspace config', () => {
      run('npm mock-dep 2.0.0 -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)

      run('local mock-dep -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(true)

      run('npm mock-dep 2.0.0 -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)
    })
  })

  describe('preserves other pnpm config', () => {
    it('keeps onlyBuiltDependencies when removing overrides', () => {
      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      pkg.pnpm = {
        onlyBuiltDependencies: ['esbuild'],
        overrides: {
          '@test/mock-dep': 'link:../mock-dep',
        },
      }
      writeJson(pkgPath, pkg)

      run('github mock-dep main -I')

      const updatedPkg = readJson(pkgPath)
      const pnpm = updatedPkg.pnpm as Record<string, unknown>
      expect(pnpm.onlyBuiltDependencies).toEqual(['esbuild'])
      expect(pnpm.overrides).toBeUndefined()
    })
  })

  describe('single-dep default', () => {
    it('defaults to single dep when none specified', () => {
      run('local -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')
    })

    it('treats single arg as ref when one dep configured', () => {
      run('github main -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe('github:test-org/mock-dep#main')
    })

    it('treats single arg as version for npm when one dep configured', () => {
      run('npm 3.0.0 -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe('^3.0.0')
    })

    it('errors when multiple deps and none specified', () => {
      // Add a second dep
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      ;(config.dependencies as Record<string, unknown>)['@test/other-dep'] = {
        localPath: '../other-dep',
        github: 'test-org/other-dep',
      }
      writeJson(configPath, config)

      expect(() => run('local -I')).toThrow(/Multiple dependencies configured/)
    })
  })
})
