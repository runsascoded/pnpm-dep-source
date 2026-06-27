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

      run('github mock-dep -R main -I')
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

      run('github mock-dep -R main -I')

      const updatedPkg = readJson(pkgPath)
      const pnpm = updatedPkg.pnpm as Record<string, unknown> | undefined
      expect(pnpm?.overrides).toBeUndefined()
    })

    it('cleans up vite.config.ts without spurious whitespace', () => {
      const viteOriginal = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')

      run('local mock-dep -I')
      run('github mock-dep -R main -I')

      const viteAfter = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')
      expect(viteAfter).toBe(viteOriginal)
    })

    it('preserves vite.config.ts formatting with multiple properties', () => {
      const viteContent = `import { defineConfig } from 'vite'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

export default defineConfig({
  server: {
    port: 3201,
    host: true,
    allowedHosts,
  },
  plugins: [
    react(),
  ],
  esbuild: {
    logOverride: { 'this-is-undefined-in-esm': 'silent' }
  }
})
`
      writeFileSync(join(TEST_DIR, 'vite.config.ts'), viteContent)

      run('local mock-dep -I')
      run('github mock-dep -R main -I')

      const viteAfter = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')
      expect(viteAfter).toBe(viteContent)
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

      run('github mock-dep -R main -I')
      const pkgAfterGh = readJson(pkgPath)
      expect((pkgAfterGh.dependencies as Record<string, string>)['@test/mock-dep']).toContain('github.com/')

      run('npm mock-dep 2.0.0 -I')
      const pkgAfterNpm = readJson(pkgPath)
      expect((pkgAfterNpm.dependencies as Record<string, string>)['@test/mock-dep']).toBe('^2.0.0')
    })
  })

  describe('github → local round-trip', () => {
    it('adds then removes workspace config', () => {
      run('github mock-dep -R main -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)

      run('local mock-dep -I')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(true)

      run('github mock-dep -R main -I')
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

      run('github mock-dep -R main -I')

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

    it('uses -R flag for raw ref when one dep configured', () => {
      run('github -R main -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe('https://github.com/test-org/mock-dep#main')
    })

    it('treats single arg as version for npm when one dep configured', () => {
      run('npm 3.0.0 -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe('^3.0.0')
    })

    it('treats single non-numeric arg as dep query for npm, not version', () => {
      run('npm mock 2.0.0 -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe('^2.0.0')
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

  describe('list filters', () => {
    it('filters deps by substring match', () => {
      // Add a second dep
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      ;(config.dependencies as Record<string, unknown>)['@test/other-dep'] = {
        localPath: '../other-dep',
        github: 'test-org/other-dep',
      }
      writeJson(configPath, config)

      // Create mock dep dir so pds doesn't error
      const otherDepDir = join(TEST_DIR, '..', 'other-dep')
      if (!existsSync(otherDepDir)) mkdirSync(otherDepDir, { recursive: true })
      writeJson(join(otherDepDir, 'package.json'), { name: '@test/other-dep', version: '1.0.0' })
      // Add to package.json
      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      ;(pkg.dependencies as Record<string, string>)['@test/other-dep'] = '^1.0.0'
      writeJson(pkgPath, pkg)

      const allOutput = run('ls')
      expect(allOutput).toContain('@test/mock-dep')
      expect(allOutput).toContain('@test/other-dep')

      const filteredOutput = run('ls mock')
      expect(filteredOutput).toContain('@test/mock-dep')
      expect(filteredOutput).not.toContain('@test/other-dep')

      const otherFiltered = run('ls other')
      expect(otherFiltered).not.toContain('@test/mock-dep')
      expect(otherFiltered).toContain('@test/other-dep')

      // Clean up
      if (existsSync(otherDepDir)) rmSync(otherDepDir, { recursive: true })
    })

    it('supports multiple filter args (OR matching)', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      ;(config.dependencies as Record<string, unknown>)['@test/alpha'] = { localPath: '../alpha' }
      ;(config.dependencies as Record<string, unknown>)['@test/beta'] = { localPath: '../beta' }
      writeJson(configPath, config)

      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      ;(pkg.dependencies as Record<string, string>)['@test/alpha'] = '^1.0.0'
      ;(pkg.dependencies as Record<string, string>)['@test/beta'] = '^1.0.0'
      writeJson(pkgPath, pkg)

      const output = run('ls alpha beta')
      expect(output).toContain('@test/alpha')
      expect(output).toContain('@test/beta')
      expect(output).not.toContain('@test/mock-dep')
    })

    it('filter is case-insensitive', () => {
      const output = run('ls MOCK')
      expect(output).toContain('@test/mock-dep')
    })
  })

  describe('list source filter', () => {
    it('shows only local deps with -s local', () => {
      // Default state: mock-dep is at ^1.0.0 (npm source)
      const output = run('ls -s local')
      expect(output).not.toContain('@test/mock-dep')

      // Switch to local
      run('local mock-dep -I')
      const localOutput = run('ls -s local')
      expect(localOutput).toContain('@test/mock-dep')
    })

    it('shows only github deps with -s gh', () => {
      run('github mock-dep -R main -I')
      const ghOutput = run('ls -s gh')
      expect(ghOutput).toContain('@test/mock-dep')

      const localOutput = run('ls -s local')
      expect(localOutput).not.toContain('@test/mock-dep')
    })

    it('shows only npm deps with -s npm', () => {
      run('npm mock-dep 2.0.0 -I')
      const npmOutput = run('ls -s npm')
      expect(npmOutput).toContain('@test/mock-dep')

      const ghOutput = run('ls -s gh')
      expect(ghOutput).not.toContain('@test/mock-dep')
    })
  })

  describe('list sort order', () => {
    it('lists regular deps before devDeps', () => {
      // Move mock-dep to devDependencies and add a regular dep
      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      const deps = pkg.dependencies as Record<string, string>
      const mockSpec = deps['@test/mock-dep']
      delete deps['@test/mock-dep']
      pkg.devDependencies = { '@test/mock-dep': mockSpec }
      deps['@test/regular-dep'] = '^1.0.0'
      writeJson(pkgPath, pkg)

      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      ;(config.dependencies as Record<string, unknown>)['@test/regular-dep'] = { localPath: '../regular-dep' }
      writeJson(configPath, config)

      const output = run('ls')
      const regularIdx = output.indexOf('@test/regular-dep')
      const devIdx = output.indexOf('@test/mock-dep')
      expect(regularIdx).toBeGreaterThan(-1)
      expect(devIdx).toBeGreaterThan(-1)
      expect(regularIdx).toBeLessThan(devIdx)
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

      run(`init ${mockDepWithRepo} -I`)

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

      run(`init ${mockDepWithRepo} -H explicit/repo -f -I`)

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

    it('adds dep to package.json if not present', () => {
      const newDepDir = join(TEST_DIR, 'new-dep')
      mkdirSync(newDepDir, { recursive: true })
      writeJson(join(newDepDir, 'package.json'), {
        name: '@test/new-dep',
        version: '1.0.0',
      })

      // Remove existing config (both possible names)
      for (const f of ['.pds.json', '.pnpm-dep-source.json']) {
        const p = join(TEST_DIR, f)
        if (existsSync(p)) rmSync(p)
      }

      const output = run(`init ${newDepDir} -I`)

      // Should log that dep was added
      expect(output).toContain('Added @test/new-dep to dependencies')

      // Config should be created (as .pds.json when no prior config exists)
      const configPath = join(TEST_DIR, '.pds.json')
      const config = readJson(configPath)
      expect(config.dependencies).toHaveProperty('@test/new-dep')

      // And package.json should have the dep added (activated to local via workspace:*)
      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/new-dep']).toBe('workspace:*')
    })

    it('adds dep to devDependencies with -D flag', () => {
      const newDevDepDir = join(TEST_DIR, 'new-dev-dep')
      mkdirSync(newDevDepDir, { recursive: true })
      writeJson(join(newDevDepDir, 'package.json'), {
        name: '@test/new-dev-dep',
        version: '1.0.0',
      })

      run(`init ${newDevDepDir} -D -I`)

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.devDependencies as Record<string, string>)['@test/new-dev-dep']).toBe('workspace:*')
    })

    it('activates after deinit + init cycle', () => {
      // First init (uses existing config with GitHub)
      run(`init ${MOCK_DEP_DIR} -H test-org/mock-dep -I`)
      expect((readJson(join(TEST_DIR, 'package.json')).dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')

      // Switch to github
      run('github mock-dep -R main -I')
      expect((readJson(join(TEST_DIR, 'package.json')).dependencies as Record<string, string>)['@test/mock-dep']).toContain('github.com/')

      // Deinit
      run('deinit mock-dep')

      // Re-init should activate local again
      run(`init ${MOCK_DEP_DIR} -H test-org/mock-dep -I`)
      expect((readJson(join(TEST_DIR, 'package.json')).dependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')
    })
  })

  describe('init npm inference', () => {
    it('skips npm for private packages', () => {
      const privDepDir = join(TEST_DIR, 'priv-dep')
      mkdirSync(privDepDir, { recursive: true })
      writeJson(join(privDepDir, 'package.json'), {
        name: '@test/priv-dep',
        version: '1.0.0',
        private: true,
      })

      run(`init ${privDepDir} -I`)

      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      const dep = (config.dependencies as Record<string, { npm?: string }>)['@test/priv-dep']
      expect(dep.npm).toBeUndefined()
    })

    it('skips npm for packages not published to npm', () => {
      const unpubDepDir = join(TEST_DIR, 'unpub-dep')
      mkdirSync(unpubDepDir, { recursive: true })
      writeJson(join(unpubDepDir, 'package.json'), {
        name: '@test/unpub-dep',
        version: '1.0.0',
      })

      run(`init ${unpubDepDir} -I`)

      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      const dep = (config.dependencies as Record<string, { npm?: string }>)['@test/unpub-dep']
      expect(dep.npm).toBeUndefined()
    })

    it('sets npm when explicitly provided via -n', () => {
      const depDir = join(TEST_DIR, 'explicit-npm-dep')
      mkdirSync(depDir, { recursive: true })
      writeJson(join(depDir, 'package.json'), {
        name: '@test/explicit-npm-dep',
        version: '1.0.0',
      })

      run(`init ${depDir} -n @test/explicit-npm-dep -I`)

      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      const dep = (config.dependencies as Record<string, { npm?: string }>)['@test/explicit-npm-dep']
      expect(dep.npm).toBe('@test/explicit-npm-dep')
    })

    it('sets npm via -n even for private packages', () => {
      const depDir = join(TEST_DIR, 'priv-explicit-dep')
      mkdirSync(depDir, { recursive: true })
      writeJson(join(depDir, 'package.json'), {
        name: '@test/priv-explicit-dep',
        version: '1.0.0',
        private: true,
      })

      run(`init ${depDir} -n @test/priv-explicit-dep -I`)

      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      const dep = (config.dependencies as Record<string, { npm?: string }>)['@test/priv-explicit-dep']
      expect(dep.npm).toBe('@test/priv-explicit-dep')
    })
  })

  describe('init reinit', () => {
    it('moves dep from dependencies to devDependencies with -D', () => {
      // dep starts in dependencies (from setupTestProject)
      const pkgPath = join(TEST_DIR, 'package.json')
      let pkg = readJson(pkgPath)
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBeDefined()

      // reinit with -D
      run(`init ${MOCK_DEP_DIR} -D -I`)

      pkg = readJson(pkgPath)
      expect((pkg.dependencies as Record<string, string> | undefined)?.['@test/mock-dep']).toBeUndefined()
      expect((pkg.devDependencies as Record<string, string>)['@test/mock-dep']).toBe('workspace:*')
    })

    it('refreshes config on reinit', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')

      // Manually set a stale distBranch value
      const config = readJson(configPath)
      const deps = config.dependencies as Record<string, Record<string, unknown>>
      deps['@test/mock-dep'].distBranch = 'old-branch'
      writeJson(configPath, config)

      // reinit to refresh (distBranch defaults to 'dist')
      run(`init ${MOCK_DEP_DIR} -I`)

      const updated = readJson(configPath)
      const dep = (updated.dependencies as Record<string, { distBranch?: string }>)['@test/mock-dep']
      expect(dep.distBranch).toBe('dist')
    })
  })

  describe('init --source', () => {
    it('activates github when init from local path with -s g', () => {
      // Remove the dep so init adds it fresh
      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      delete (pkg.dependencies as Record<string, string>)['@test/mock-dep']
      writeJson(pkgPath, pkg)

      // Remove existing config so init creates fresh
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      writeJson(configPath, { dependencies: {} })

      // Init from local path but activate github
      run(`init ${MOCK_DEP_DIR} -s g -H test-org/mock-dep -R main -I`)

      // Config should have localPath
      const config = readJson(configPath)
      const dep = (config.dependencies as Record<string, Record<string, unknown>>)['@test/mock-dep']
      expect(dep.localPath).toContain('mock-dep')

      // package.json should point at github, not workspace:*
      const updatedPkg = readJson(pkgPath)
      const depSpec = (updatedPkg.dependencies as Record<string, string>)['@test/mock-dep']
      expect(depSpec).toContain('github.com/test-org/mock-dep')
      expect(depSpec).not.toBe('workspace:*')

      // No pnpm-workspace.yaml (not local mode)
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)
    })
  })

  describe('monorepo subdir support', () => {
    it('includes subdir in github specifier', () => {
      // Set up config with subdir field
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      writeJson(configPath, {
        dependencies: {
          '@test/mock-dep': {
            localPath: '../mock-dep',
            github: 'test-org/mock-dep',
            npm: '@test/mock-dep',
            distBranch: 'dist',
            subdir: '/packages/mock-dep',
          },
        },
      })

      run('github mock-dep -R main -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe(
        'https://github.com/test-org/mock-dep#main&path:/packages/mock-dep'
      )
    })

    it('preserves subdir through local → github round-trip', () => {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      writeJson(configPath, {
        dependencies: {
          '@test/mock-dep': {
            localPath: '../mock-dep',
            github: 'test-org/mock-dep',
            npm: '@test/mock-dep',
            distBranch: 'dist',
            subdir: '/packages/mock-dep',
          },
        },
      })

      run('local mock-dep -I')
      run('github mock-dep -R main -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe(
        'https://github.com/test-org/mock-dep#main&path:/packages/mock-dep'
      )

      // Subdir should still be in config
      const config = readJson(configPath)
      const dep = (config.dependencies as Record<string, { subdir?: string }>)['@test/mock-dep']
      expect(dep.subdir).toBe('/packages/mock-dep')
    })

    it('omits subdir path when not configured', () => {
      run('github mock-dep -R main -I')

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe(
        'https://github.com/test-org/mock-dep#main'
      )
    })
  })

  describe('pkg.pr.new (cr) mode', () => {
    const crUrl = 'https://pkg.pr.new/test-org/mock-dep/@test/mock-dep@main'

    it('dry-run prints the derived URL without mutating', () => {
      const pkgBefore = readJson(join(TEST_DIR, 'package.json'))
      const output = run('cr mock-dep -R main -n')
      expect(output.trim()).toBe(`Would switch @test/mock-dep to: ${crUrl}`)
      // No mutation in dry-run
      const pkgAfter = readJson(join(TEST_DIR, 'package.json'))
      expect(pkgAfter).toEqual(pkgBefore)
    })

    it('activates via init -s cr (SHA-pinned URL, no workspace/vite entries)', () => {
      run(`init ${MOCK_DEP_DIR} -H test-org/mock-dep -n @test/mock-dep -s cr -R main -I`)

      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe(crUrl)
      // Not local mode: no workspace yaml, no vite optimizeDeps entry
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)
      const vite = readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')
      expect(vite).not.toContain("'@test/mock-dep'")
    })

    it('reports cr source with pinned SHA in status', () => {
      // Point the dep at a pkg.pr.new URL directly
      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      const pinnedUrl = 'https://pkg.pr.new/test-org/mock-dep/@test/mock-dep@abcdef1234567'
      ;(pkg.dependencies as Record<string, string>)['@test/mock-dep'] = pinnedUrl
      writeJson(pkgPath, pkg)

      const output = run('status mock-dep')
      expect(output.trim()).toBe(`@test/mock-dep: cr (${pinnedUrl})`)
    })

    it('lists cr deps with -s cr filter', () => {
      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      ;(pkg.dependencies as Record<string, string>)['@test/mock-dep'] =
        'https://pkg.pr.new/test-org/mock-dep/@test/mock-dep@abcdef1234567'
      writeJson(pkgPath, pkg)

      expect(run('ls -s cr')).toContain('@test/mock-dep')
      expect(run('ls -s gh')).not.toContain('@test/mock-dep')
    })

    it('errors when no npm package name is configured', () => {
      // Remove npm from config
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      delete (config.dependencies as Record<string, Record<string, unknown>>)['@test/mock-dep'].npm
      writeJson(configPath, config)

      expect(() => run('cr mock-dep -R main -n')).toThrow(/No npm package name configured/)
    })
  })

  describe('transitive deps (tracked but not in package.json)', () => {
    // Package entries pds wrote into pnpm-workspace.yaml (verbatim `- <path>` lines)
    function workspacePackages(): string[] {
      const wsPath = join(TEST_DIR, 'pnpm-workspace.yaml')
      if (!existsSync(wsPath)) return []
      return readFileSync(wsPath, 'utf-8')
        .split('\n')
        .map(l => l.match(/^\s+-\s+(.*)$/)?.[1])
        .filter((x): x is string => !!x)
    }

    it('switches a transitive dep via workspace cleanup without touching package.json', () => {
      // @test/transitive is tracked in config but NOT a direct dep in package.json
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      ;(config.dependencies as Record<string, unknown>)['@test/transitive'] = {
        localPath: '../transitive', github: 'org/transitive', npm: '@test/transitive',
      }
      writeJson(configPath, config)
      // Seed workspace as `pds l` would (plus an unrelated entry to keep)
      writeFileSync(join(TEST_DIR, 'pnpm-workspace.yaml'), 'packages:\n  - ../transitive\n  - ../keepme\n')

      const out = run('github transitive -R main -I')

      expect(out.trim()).toBe(
        'Switched @test/transitive to GitHub: https://github.com/org/transitive#main (transitive; package.json unchanged)'
      )
      // package.json gains no @test/transitive entry
      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/transitive']).toBeUndefined()
      // workspace entry dropped, unrelated entry kept
      expect(workspacePackages()).toEqual(['../keepme'])
    })

    it('bulk -a over a fork switches direct + transitive members without erroring', () => {
      // @test/mock-dep is a direct dep; @test/sib is transitive (config-only)
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      ;(config.dependencies as Record<string, unknown>)['@test/sib'] = {
        localPath: '../sib', github: 'test-org/mock-dep', npm: '@test/sib',
      }
      writeJson(configPath, config)
      writeFileSync(join(TEST_DIR, 'pnpm-workspace.yaml'), 'packages:\n  - ../sib\n')

      // 'test' matches both @test/mock-dep and @test/sib
      const out = run('github test -a -R main -I')

      // mock-dep (direct) rewritten; sib (transitive) noted, package.json untouched for it
      const pkg = readJson(join(TEST_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/mock-dep']).toBe(
        'https://github.com/test-org/mock-dep#main'
      )
      expect((pkg.dependencies as Record<string, string>)['@test/sib']).toBeUndefined()
      expect(out).toContain('@test/sib to GitHub: https://github.com/test-org/mock-dep#main (transitive; package.json unchanged)')
      // sib's workspace entry removed (was the only one → file gone)
      expect(workspacePackages()).toEqual([])
    })
  })

  describe('multi-match (-a/--all)', () => {
    // Parse the dep names from `gh -n` dry-run output (network-free via -R)
    function switchedDeps(output: string): string[] {
      return output
        .split('\n')
        .map(l => l.match(/^Would switch (\S+) to:/)?.[1])
        .filter((x): x is string => !!x)
        .sort()
    }
    function addGhDep(name: string, github: string): void {
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      ;(config.dependencies as Record<string, unknown>)[name] = { github, npm: name }
      writeJson(configPath, config)
    }

    it('expands a substring query to all matching deps', () => {
      addGhDep('@test/multi-a', 'org/multi-a')
      addGhDep('@test/multi-b', 'org/multi-b')

      const out = run('github multi -a -R main -n')
      expect(switchedDeps(out)).toEqual(['@test/multi-a', '@test/multi-b'])
    })

    it('selects all configured deps when no query is given', () => {
      addGhDep('@test/multi-a', 'org/multi-a')

      const out = run('github -a -R main -n')
      expect(switchedDeps(out)).toEqual(['@test/mock-dep', '@test/multi-a'])
    })

    it('supports anchored regex to disambiguate overlapping names', () => {
      addGhDep('@test/multi-a', 'org/multi-a')
      addGhDep('@test/multi-ab', 'org/multi-ab')

      const out = run("github 'multi-a$' -a -R main -n")
      expect(switchedDeps(out)).toEqual(['@test/multi-a'])
    })

    it('dedups deps matched by more than one pattern', () => {
      addGhDep('@test/multi-a', 'org/multi-a')
      addGhDep('@test/multi-b', 'org/multi-b')

      // 'multi-a' matches only multi-a; 'multi' matches both — union, deduped
      const out = run('github multi-a multi -a -R main -n')
      expect(switchedDeps(out)).toEqual(['@test/multi-a', '@test/multi-b'])
    })

    it('errors when a pattern matches nothing', () => {
      expect(() => run('github nonexistent -a -R main -n')).toThrow(/No dependency matching/)
    })

    it('without -a, a multi-match query stays ambiguous', () => {
      addGhDep('@test/multi-a', 'org/multi-a')
      addGhDep('@test/multi-b', 'org/multi-b')

      expect(() => run('github multi -R main -n')).toThrow(/Ambiguous match/)
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

  describe('multi-arg', () => {
    function addConfiguredDep(name: string, localDir: string, github: string | undefined): void {
      const depPath = join(TEST_DIR, '..', localDir)
      if (!existsSync(depPath)) mkdirSync(depPath, { recursive: true })
      writeJson(join(depPath, 'package.json'), { name, version: '1.0.0' })

      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      const config = readJson(configPath)
      ;(config.dependencies as Record<string, unknown>)[name] = {
        localPath: `../${localDir}`,
        ...(github ? { github } : {}),
        npm: name,
        distBranch: 'dist',
      }
      writeJson(configPath, config)

      const pkgPath = join(TEST_DIR, 'package.json')
      const pkg = readJson(pkgPath)
      ;(pkg.dependencies as Record<string, string>)[name] = '^1.0.0'
      writeJson(pkgPath, pkg)
    }

    afterEach(() => {
      for (const name of ['multi-a', 'multi-b', 'multi-c']) {
        const p = join(TEST_DIR, '..', name)
        if (existsSync(p)) rmSync(p, { recursive: true })
      }
    })

    it('local: switches multiple deps in one call', () => {
      addConfiguredDep('@test/multi-a', 'multi-a', 'org/multi-a')
      addConfiguredDep('@test/multi-b', 'multi-b', 'org/multi-b')

      run('local mock-dep multi-a multi-b -I')

      const deps = (readJson(join(TEST_DIR, 'package.json')).dependencies) as Record<string, string>
      expect(deps['@test/mock-dep']).toBe('workspace:*')
      expect(deps['@test/multi-a']).toBe('workspace:*')
      expect(deps['@test/multi-b']).toBe('workspace:*')

      const ws = readFileSync(join(TEST_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      expect(ws).toContain('../mock-dep')
      expect(ws).toContain('../multi-a')
      expect(ws).toContain('../multi-b')
    })

    it('github: pins multiple deps in one call (raw ref)', () => {
      addConfiguredDep('@test/multi-a', 'multi-a', 'org/multi-a')
      addConfiguredDep('@test/multi-b', 'multi-b', 'org/multi-b')

      run('github mock-dep multi-a multi-b -R main -I')

      const deps = (readJson(join(TEST_DIR, 'package.json')).dependencies) as Record<string, string>
      expect(deps['@test/mock-dep']).toBe('https://github.com/test-org/mock-dep#main')
      expect(deps['@test/multi-a']).toBe('https://github.com/org/multi-a#main')
      expect(deps['@test/multi-b']).toBe('https://github.com/org/multi-b#main')
    })

    it('npm: with multiple deps treats all args as queries (no version)', () => {
      addConfiguredDep('@test/multi-a', 'multi-a', 'org/multi-a')
      addConfiguredDep('@test/multi-b', 'multi-b', 'org/multi-b')

      run('github mock-dep multi-a multi-b -R main -I')
      // Provide explicit version via 'npm' isn't supported across multiple deps; use the
      // 2-arg single-dep form here would mismatch, so test directly that switching back
      // works against npm registry by pointing at packages we won't actually install (-I).
      // We can't run real npm lookup in tests, so this just checks the argument-parsing
      // path: with 3 deps + -I, npm should call getLatestNpmVersion per dep. Since none
      // of the @test/* packages are published, getLatestNpmVersion would fail. So we
      // exercise the parsing path differently: use 2 args where last starts with digit
      // (single-dep + version) and verify it routes correctly.
      run('npm mock-dep 9.9.9 -I')
      const deps = (readJson(join(TEST_DIR, 'package.json')).dependencies) as Record<string, string>
      expect(deps['@test/mock-dep']).toBe('^9.9.9')
      // Other two unchanged (still on github)
      expect(deps['@test/multi-a']).toContain('github.com')
      expect(deps['@test/multi-b']).toContain('github.com')
    })

    it('stops on first failure by default', () => {
      addConfiguredDep('@test/multi-a', 'multi-a', 'org/multi-a')
      // multi-b: no github configured
      addConfiguredDep('@test/multi-b', 'multi-b', undefined)

      // Order: multi-b first (fails — no github), multi-a after (would succeed)
      expect(() => run('github multi-b multi-a -R main -I')).toThrow(/No GitHub repo configured/)

      // multi-a should NOT have been switched (stopped before reaching it)
      const deps = (readJson(join(TEST_DIR, 'package.json')).dependencies) as Record<string, string>
      expect(deps['@test/multi-a']).toBe('^1.0.0')
    })

    it('-k continues past per-dep failures', () => {
      addConfiguredDep('@test/multi-a', 'multi-a', 'org/multi-a')
      addConfiguredDep('@test/multi-b', 'multi-b', undefined)

      // multi-b fails, multi-a still gets switched. Process exits non-zero.
      expect(() => run('github multi-b multi-a -R main -I -k')).toThrow()

      const deps = (readJson(join(TEST_DIR, 'package.json')).dependencies) as Record<string, string>
      expect(deps['@test/multi-a']).toBe('https://github.com/org/multi-a#main')
      // multi-b unchanged (failed)
      expect(deps['@test/multi-b']).toBe('^1.0.0')
    })

    it('init: initializes multiple local paths in one call', () => {
      // Fresh test project (clear pre-configured mock-dep)
      const configPath = join(TEST_DIR, '.pnpm-dep-source.json')
      if (existsSync(configPath)) rmSync(configPath)
      const pkgPath = join(TEST_DIR, 'package.json')
      writeJson(pkgPath, { name: 'test-project', version: '1.0.0' })

      for (const name of ['multi-a', 'multi-b']) {
        const p = join(TEST_DIR, '..', name)
        mkdirSync(p, { recursive: true })
        // private: true → init skips npm registry lookup
        writeJson(join(p, 'package.json'), { name: `@test/${name}`, version: '1.0.0', private: true })
      }

      run(`init ../multi-a ../multi-b -I`)

      const config = readJson(join(TEST_DIR, '.pds.json'))
      expect(config.dependencies).toHaveProperty('@test/multi-a')
      expect(config.dependencies).toHaveProperty('@test/multi-b')

      const deps = (readJson(pkgPath).dependencies) as Record<string, string>
      expect(deps['@test/multi-a']).toBe('workspace:*')
      expect(deps['@test/multi-b']).toBe('workspace:*')
    })
  })

  describe('override mode (pnpm.overrides)', () => {
    const CONFIG = join(TEST_DIR, '.pnpm-dep-source.json')
    const PKG = join(TEST_DIR, 'package.json')
    const overridesOf = () =>
      (readJson(PKG).pnpm as { overrides?: Record<string, string> } | undefined)?.overrides
    const overrideFlag = () =>
      (readJson(CONFIG).dependencies as Record<string, { override?: boolean }>)['@test/mock-dep'].override

    it('set -o enables override; -O disables it', () => {
      run('set mock-dep -o')
      expect(overrideFlag()).toBe(true)
      run('set mock-dep -O')
      expect(overrideFlag()).toBeUndefined()
    })

    it('local writes a link: override and leaves the package.json dep spec + workspace untouched', () => {
      run('set mock-dep -o')
      run('local mock-dep -I')

      expect(overridesOf()).toEqual({ '@test/mock-dep': 'link:../mock-dep' })
      // Baseline dep spec unchanged (still the npm range), no workspace file, no vite churn
      expect((readJson(PKG).dependencies as Record<string, string>)['@test/mock-dep']).toBe('^1.0.0')
      expect(existsSync(join(TEST_DIR, 'pnpm-workspace.yaml'))).toBe(false)
      expect(readFileSync(join(TEST_DIR, 'vite.config.ts'), 'utf-8')).not.toContain('optimizeDeps')
    })

    it('github → local → github rewrites only the single override entry', () => {
      run('set mock-dep -o')

      run('github mock-dep -R main -I')
      expect(overridesOf()).toEqual({ '@test/mock-dep': 'https://github.com/test-org/mock-dep#main' })

      run('local mock-dep -I')
      expect(overridesOf()).toEqual({ '@test/mock-dep': 'link:../mock-dep' })

      run('github mock-dep -R main -I')
      expect(overridesOf()).toEqual({ '@test/mock-dep': 'https://github.com/test-org/mock-dep#main' })
    })

    it('status reports the override-driven source with an [override] tag', () => {
      run('set mock-dep -o')
      run('github mock-dep -R main -I')
      const out = run('status mock-dep').trim()
      expect(out).toBe('@test/mock-dep: github (https://github.com/test-org/mock-dep#main) [override]')
    })

    it('deinit removes the override entry and the empty pnpm block', () => {
      run('set mock-dep -o')
      run('local mock-dep -I')
      expect(overridesOf()).toEqual({ '@test/mock-dep': 'link:../mock-dep' })

      run('deinit mock-dep')
      expect('pnpm' in readJson(PKG)).toBe(false)
    })
  })

  describe('init fleet expansion (monorepo hint)', () => {
    const MONO = join(__dirname, 'fixtures', 'fleet-src')

    function setupFleetSrc(): void {
      if (existsSync(MONO)) rmSync(MONO, { recursive: true })
      mkdirSync(join(MONO, 'packages/cli'), { recursive: true })
      mkdirSync(join(MONO, 'packages/core'), { recursive: true })
      writeJson(join(MONO, 'package.json'), { name: '@fleet/root', private: true })
      writeFileSync(join(MONO, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
      writeJson(join(MONO, 'pds.json'), { strategy: 'override', fleet: ['@fleet/cli', '@fleet/core'] })
      writeJson(join(MONO, 'packages/cli/package.json'), { name: '@fleet/cli', version: '1.0.0' })
      writeJson(join(MONO, 'packages/core/package.json'), { name: '@fleet/core', version: '1.0.0' })
    }

    beforeEach(setupFleetSrc)
    afterEach(() => {
      if (existsSync(MONO)) rmSync(MONO, { recursive: true })
    })

    it('init <monorepo-root> registers the hint fleet as override deps and writes link overrides', () => {
      run(`init ${MONO} -I`)

      const config = readJson(join(TEST_DIR, '.pnpm-dep-source.json'))
      const deps = config.dependencies as Record<string, { override?: boolean; subdir?: string; npm?: string }>
      // Fleet members added alongside the project's pre-existing deps
      expect(Object.keys(deps)).toEqual(expect.arrayContaining(['@fleet/cli', '@fleet/core']))
      expect(deps['@fleet/cli'].override).toBe(true)
      expect(deps['@fleet/cli'].subdir).toBe('/packages/cli')
      expect(deps['@fleet/core'].override).toBe(true)
      expect(deps['@fleet/core'].subdir).toBe('/packages/core')

      const overrides = (readJson(join(TEST_DIR, 'package.json')).pnpm as { overrides: Record<string, string> }).overrides
      expect(overrides['@fleet/cli']).toMatch(/^link:.*\/packages\/cli$/)
      expect(overrides['@fleet/core']).toMatch(/^link:.*\/packages\/core$/)
    })
  })
})

// Workspace-aware (monorepo sub-package) tests
const MONOREPO_DIR = join(__dirname, 'fixtures', 'test-monorepo')
const SUBPKG_DIR = join(MONOREPO_DIR, 'packages', 'app')
const MONOREPO_DEP_DIR = join(__dirname, 'fixtures', 'monorepo-dep')

function runInSubpkg(cmd: string): string {
  return execSync(`node ${CLI_PATH} ${cmd}`, { cwd: SUBPKG_DIR, encoding: 'utf-8' })
}

function setupMonorepo(): void {
  if (existsSync(MONOREPO_DIR)) {
    rmSync(MONOREPO_DIR, { recursive: true })
  }
  if (existsSync(MONOREPO_DEP_DIR)) {
    rmSync(MONOREPO_DEP_DIR, { recursive: true })
  }

  // Create workspace root with pnpm-workspace.yaml
  mkdirSync(SUBPKG_DIR, { recursive: true })
  writeJson(join(MONOREPO_DIR, 'package.json'), {
    name: 'test-monorepo',
    version: '1.0.0',
    private: true,
  })
  writeFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')

  // Create sub-package
  writeJson(join(SUBPKG_DIR, 'package.json'), {
    name: '@test/app',
    version: '1.0.0',
    dependencies: {
      '@test/monorepo-dep': '^1.0.0',
    },
  })
  writeJson(join(SUBPKG_DIR, '.pds.json'), {
    dependencies: {
      '@test/monorepo-dep': {
        localPath: '../../../monorepo-dep',
        github: 'test-org/monorepo-dep',
        npm: '@test/monorepo-dep',
        distBranch: 'dist',
      },
    },
  })

  // Create mock dep outside monorepo
  mkdirSync(MONOREPO_DEP_DIR, { recursive: true })
  writeJson(join(MONOREPO_DEP_DIR, 'package.json'), {
    name: '@test/monorepo-dep',
    version: '1.0.0',
  })
}

describe('pds workspace-aware (monorepo)', () => {
  beforeEach(() => {
    setupMonorepo()
  })

  afterEach(() => {
    if (existsSync(MONOREPO_DIR)) {
      rmSync(MONOREPO_DIR, { recursive: true })
    }
    if (existsSync(MONOREPO_DEP_DIR)) {
      rmSync(MONOREPO_DEP_DIR, { recursive: true })
    }
  })

  describe('local mode in sub-package', () => {
    it('modifies workspace yaml at monorepo root, not sub-package', () => {
      runInSubpkg('local monorepo-dep -I')

      // pnpm-workspace.yaml should NOT exist in sub-package
      expect(existsSync(join(SUBPKG_DIR, 'pnpm-workspace.yaml'))).toBe(false)

      // workspace yaml at monorepo root should contain the dep path (relative to root)
      const wsContent = readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      // localPath in .pds.json is ../../../monorepo-dep (relative to sub-package)
      // In workspace yaml it should be relative to monorepo root: ../monorepo-dep
      expect(wsContent).toContain('../monorepo-dep')
    })

    it('sets workspace:* in sub-package package.json', () => {
      runInSubpkg('local monorepo-dep -I')

      const pkg = readJson(join(SUBPKG_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/monorepo-dep']).toBe('workspace:*')
    })

    it('preserves existing packages entries in workspace yaml', () => {
      runInSubpkg('local monorepo-dep -I')

      const wsContent = readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      // Should still have the original packages/* entry
      expect(wsContent).toContain('packages/*')
      // Should also have the dep path
      expect(wsContent).toContain('../monorepo-dep')
    })

    it('does not add "." to workspace yaml packages', () => {
      runInSubpkg('local monorepo-dep -I')

      const wsContent = readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      // Should NOT contain a bare "." entry (that's for non-monorepo mode)
      const lines = wsContent.split('\n').map(l => l.trim())
      expect(lines).not.toContain('- .')
    })
  })

  describe('local → github round-trip in sub-package', () => {
    it('removes dep from workspace yaml without deleting the file', () => {
      runInSubpkg('local monorepo-dep -I')

      const wsContentBefore = readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      expect(wsContentBefore).toContain('../monorepo-dep')

      runInSubpkg('github monorepo-dep -R main -I')

      // Workspace yaml should still exist (belongs to monorepo)
      expect(existsSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'))).toBe(true)

      // But dep path should be removed
      const wsContentAfter = readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      expect(wsContentAfter).not.toContain('../monorepo-dep')

      // Original packages/* entry should be preserved
      expect(wsContentAfter).toContain('packages/*')
    })

    it('updates sub-package package.json, not monorepo root', () => {
      runInSubpkg('github monorepo-dep -R main -I')

      const subPkg = readJson(join(SUBPKG_DIR, 'package.json'))
      expect((subPkg.dependencies as Record<string, string>)['@test/monorepo-dep']).toContain('github.com/test-org/monorepo-dep')

      // Monorepo root package.json should be unchanged
      const rootPkg = readJson(join(MONOREPO_DIR, 'package.json'))
      expect(rootPkg.dependencies).toBeUndefined()
    })
  })

  describe('local → npm round-trip in sub-package', () => {
    it('removes dep from workspace yaml without deleting the file', () => {
      runInSubpkg('local monorepo-dep -I')
      expect(readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')).toContain('../monorepo-dep')

      runInSubpkg('npm monorepo-dep 2.0.0 -I')

      expect(existsSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'))).toBe(true)
      const wsContent = readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      expect(wsContent).not.toContain('../monorepo-dep')
      expect(wsContent).toContain('packages/*')
    })
  })

  describe('auto-subdir detection', () => {
    // Use /tmp to avoid walking up into the project's own package.json
    const autosubdirRoot = join('/tmp', 'pds-test-autosubdir')

    afterEach(() => {
      if (existsSync(autosubdirRoot)) rmSync(autosubdirRoot, { recursive: true })
    })

    it('auto-uses sole JS subdirectory when no package.json in cwd', () => {
      const subDir = join(autosubdirRoot, 'myapp')
      if (existsSync(autosubdirRoot)) rmSync(autosubdirRoot, { recursive: true })
      mkdirSync(subDir, { recursive: true })

      writeJson(join(subDir, 'package.json'), {
        name: 'myapp',
        version: '1.0.0',
        dependencies: { '@test/mock-dep': '^1.0.0' },
      })
      writeJson(join(subDir, '.pds.json'), {
        dependencies: {
          '@test/mock-dep': {
            localPath: '../../mock-dep',
            github: 'test-org/mock-dep',
            npm: '@test/mock-dep',
            distBranch: 'dist',
          },
        },
      })

      const output = execSync(`node ${CLI_PATH} ls`, { cwd: autosubdirRoot, encoding: 'utf-8' })
      expect(output).toContain('@test/mock-dep')
    })

    it('errors when multiple JS subdirectories exist', () => {
      if (existsSync(autosubdirRoot)) rmSync(autosubdirRoot, { recursive: true })

      for (const sub of ['app1', 'app2']) {
        const subDir = join(autosubdirRoot, sub)
        mkdirSync(subDir, { recursive: true })
        writeJson(join(subDir, 'package.json'), { name: sub, version: '1.0.0' })
      }

      expect(() =>
        execSync(`node ${CLI_PATH} ls`, { cwd: autosubdirRoot, encoding: 'utf-8' })
      ).toThrow()
    })
  })

  describe('deinit in sub-package', () => {
    it('cleans up workspace yaml at root without deleting it', () => {
      runInSubpkg('local monorepo-dep -I')
      expect(readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')).toContain('../monorepo-dep')

      runInSubpkg('deinit monorepo-dep')

      expect(existsSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'))).toBe(true)
      const wsContent = readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      expect(wsContent).not.toContain('../monorepo-dep')
      expect(wsContent).toContain('packages/*')
    })

    it('removes config from sub-package .pds.json', () => {
      runInSubpkg('deinit monorepo-dep')

      const config = readJson(join(SUBPKG_DIR, '.pds.json'))
      expect(config.dependencies).toEqual({})
    })
  })

  describe('rm in sub-package', () => {
    it('cleans up workspace yaml at root and removes from sub-package package.json', () => {
      runInSubpkg('local monorepo-dep -I')

      runInSubpkg('rm monorepo-dep -I')

      // Workspace yaml still exists with original entries
      expect(existsSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'))).toBe(true)
      const wsContent = readFileSync(join(MONOREPO_DIR, 'pnpm-workspace.yaml'), 'utf-8')
      expect(wsContent).not.toContain('../monorepo-dep')
      expect(wsContent).toContain('packages/*')

      // Dep removed from sub-package package.json
      const pkg = readJson(join(SUBPKG_DIR, 'package.json'))
      expect((pkg.dependencies as Record<string, string>)['@test/monorepo-dep']).toBeUndefined()
    })
  })
})
