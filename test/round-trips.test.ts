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

  describe('set command', () => {
    it('updates github field', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      run('set mock-dep -H new-org/new-repo')

      const config = readJson(configPath)
      expect((config.dependencies as Record<string, { github?: string }>)['@test/mock-dep'].github).toBe('new-org/new-repo')
    })

    it('updates gitlab field', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      run('set mock-dep -L gitlab-org/repo')

      const config = readJson(configPath)
      expect((config.dependencies as Record<string, { gitlab?: string }>)['@test/mock-dep'].gitlab).toBe('gitlab-org/repo')
    })

    it('updates local path', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      run('set mock-dep -l ../other-path')

      const config = readJson(configPath)
      expect((config.dependencies as Record<string, { localPath: string }>)['@test/mock-dep'].localPath).toBe('../other-path')
    })

    it('removes field with empty string', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      // First add gitlab
      run('set mock-dep -L some-org/repo')
      let config = readJson(configPath)
      expect((config.dependencies as Record<string, { gitlab?: string }>)['@test/mock-dep'].gitlab).toBe('some-org/repo')

      // Then remove it
      run('set mock-dep -L ""')
      config = readJson(configPath)
      expect((config.dependencies as Record<string, { gitlab?: string }>)['@test/mock-dep'].gitlab).toBeUndefined()
    })

    it('updates multiple fields at once', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      run('set mock-dep -H multi/repo -L multi/gitlab -b main')

      const config = readJson(configPath)
      const dep = (config.dependencies as Record<string, { github?: string; gitlab?: string; distBranch?: string }>)['@test/mock-dep']
      expect(dep.github).toBe('multi/repo')
      expect(dep.gitlab).toBe('multi/gitlab')
      expect(dep.distBranch).toBe('main')
    })

    it('works with single-dep default', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      run('set -H default-org/repo')

      const config = readJson(configPath)
      expect((config.dependencies as Record<string, { github?: string }>)['@test/mock-dep'].github).toBe('default-org/repo')
    })
  })

  describe('init auto-detect', () => {
    it('auto-detects github from package.json repository field', () => {
      // Create a mock dep with repository field
      const mockDepWithRepo = join(TEST_DIR, 'dep-with-repo')
      mkdirSync(mockDepWithRepo, { recursive: true })
      writeJson(join(mockDepWithRepo, 'package.json'), {
        name: '@test/auto-dep',
        version: '1.0.0',
        repository: {
          type: 'git',
          url: 'git+https://github.com/auto-org/auto-repo.git',
        },
      })

      run(`init ${mockDepWithRepo}`)

      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      const dep = (config.dependencies as Record<string, { github?: string; localPath: string }>)['@test/auto-dep']
      expect(dep.github).toBe('auto-org/auto-repo')
      expect(dep.localPath).toBe('dep-with-repo')
    })

    it('uses explicit -H over auto-detected', () => {
      const mockDepWithRepo = join(TEST_DIR, 'dep-with-repo2')
      mkdirSync(mockDepWithRepo, { recursive: true })
      writeJson(join(mockDepWithRepo, 'package.json'), {
        name: '@test/override-dep',
        version: '1.0.0',
        repository: 'github:original/repo',
      })

      run(`init ${mockDepWithRepo} -H explicit/repo -f`)

      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      expect((config.dependencies as Record<string, { github?: string }>)['@test/override-dep'].github).toBe('explicit/repo')
    })
  })

  describe('init auto-activation', () => {
    it('activates local mode when init with local path', () => {
      // Remove existing config to start fresh
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      if (existsSync(configPath)) rmSync(configPath)

      run(`init ${MOCK_DEP_DIR} -I`)

      // Should have set workspace:* in package.json
      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')

      // Should have created pnpm-workspace.yaml
      const wsPath = join(TEST_DIR, 'pnpm-workspace.yaml')
      expect(existsSync(wsPath)).toBe(true)
      const wsContent = readFileSync(wsPath, 'utf-8')
      expect(wsContent).toContain('../mock-dep')
    })

    it('skips activation when dep not in package.json', () => {
      const newDepDir = join(TEST_DIR, 'new-dep')
      mkdirSync(newDepDir, { recursive: true })
      writeJson(join(newDepDir, 'package.json'), {
        name: '@test/new-dep',
        version: '1.0.0',
      })

      // Remove existing config
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      if (existsSync(configPath)) rmSync(configPath)

      const output = run(`init ${newDepDir} -I`)

      // Should log that activation was skipped
      expect(output).toContain('not in package.json')

      // Config should still be created
      const config = readJson(configPath)
      expect(config.dependencies).toHaveProperty('@test/new-dep')

      // But package.json should not be modified (no @test/new-dep entry)
      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/new-dep']).toBeUndefined()
    })

    it('activates after deinit + init cycle', () => {
      // First init (uses existing config with GitHub)
      run(`init ${MOCK_DEP_DIR} -H test-org/mock-dep -I`)
      expect((readJson(join(TEST_DIR, 'package.json')).dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')

      // Switch to github
      run('github mock-dep main -I')
      expect((readJson(join(TEST_DIR, 'package.json')).dependencies as Record<string, string>)['@test/mock-dep']).toContain('github:')

      // Deinit
      run('deinit mock-dep')

      // Re-init should activate local again
      run(`init ${MOCK_DEP_DIR} -H test-org/mock-dep -I`)
      expect((readJson(join(TEST_DIR, 'package.json')).dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')
    })
  })

  describe('deinit command', () => {
    it('removes dependency from config', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      run('deinit mock-dep')

      const config = readJson(configPath)
      expect(config.dependencies).toEqual({})
    })

    it('cleans up pnpm-workspace.yaml when removing local dep', () => {
      run('local mock-dep -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(true)

      run('deinit mock-dep')

      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)
    })

    it('cleans up vite.config.ts when removing local dep', () => {
      const viteOriginal = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')

      run('local mock-dep -I')
      run('deinit mock-dep')

      const viteAfter = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')
      expect(viteAfter).toBe(viteOriginal)
    })

    it('works with rm alias', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      run('rm mock-dep')

      const config = readJson(configPath)
      expect(config.dependencies).toEqual({})
    })

    it('works with single-dep default', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      run('deinit')

      const config = readJson(configPath)
      expect(config.dependencies).toEqual({})
    })
  })
})
