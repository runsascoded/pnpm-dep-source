import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { pdsPlugin } from '../src/vite.js'

const tmpDir = join(import.meta.dirname, 'tmp-vite-plugin')

function setupProject(opts: {
  pdsConfig?: Record<string, unknown>
  localDeps?: Record<string, Record<string, unknown>>
  installedModules?: string[]
}) {
  mkdirSync(tmpDir, { recursive: true })
  if (opts.pdsConfig) {
    writeFileSync(join(tmpDir, '.pds.json'), JSON.stringify(opts.pdsConfig))
  }
  if (opts.localDeps) {
    for (const [name, pkg] of Object.entries(opts.localDeps)) {
      const depDir = join(tmpDir, name)
      mkdirSync(depDir, { recursive: true })
      writeFileSync(join(depDir, 'package.json'), JSON.stringify(pkg))
    }
  }
  if (opts.installedModules) {
    for (const mod of opts.installedModules) {
      const modDir = join(tmpDir, 'node_modules', mod)
      mkdirSync(modDir, { recursive: true })
      writeFileSync(join(modDir, 'package.json'), JSON.stringify({ name: mod }))
    }
  }
}

describe('pdsPlugin', () => {
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined when no .pds.json exists', () => {
    mkdirSync(tmpDir, { recursive: true })
    const plugin = pdsPlugin({ root: tmpDir })
    expect(plugin.name).toBe('pds-resolve')
    expect(plugin.config()).toBeUndefined()
  })

  it('returns undefined when no local deps', () => {
    setupProject({
      pdsConfig: {
        dependencies: {
          'my-dep': { github: 'user/repo' },
        },
      },
    })
    const plugin = pdsPlugin({ root: tmpDir })
    expect(plugin.config()).toBeUndefined()
  })

  it('aliases peer dependencies of local deps', () => {
    setupProject({
      pdsConfig: {
        dependencies: {
          'my-dep': { localPath: 'my-dep', github: 'user/repo' },
        },
      },
      localDeps: {
        'my-dep': {
          peerDependencies: { 'some-lib': '^1.0.0' },
        },
      },
      installedModules: ['some-lib'],
    })
    const plugin = pdsPlugin({ root: tmpDir })
    const result = plugin.config()
    expect(result).toBeDefined()
    expect(result!.resolve.alias).toEqual({
      'some-lib': join(tmpDir, 'node_modules', 'some-lib'),
    })
  })

  it('adds react/jsx-runtime alias for react peer', () => {
    const jsxDir = join(tmpDir, 'node_modules', 'react', 'jsx-runtime')
    setupProject({
      pdsConfig: {
        dependencies: {
          'my-dep': { localPath: 'my-dep' },
        },
      },
      localDeps: {
        'my-dep': {
          peerDependencies: { react: '^18.0.0' },
        },
      },
      installedModules: ['react'],
    })
    mkdirSync(jsxDir, { recursive: true })
    const plugin = pdsPlugin({ root: tmpDir })
    const result = plugin.config()
    expect(result).toBeDefined()
    const aliases = result!.resolve.alias
    expect(aliases['react']).toBe(join(tmpDir, 'node_modules', 'react'))
    expect(aliases['react/jsx-runtime']).toBe(jsxDir)
  })

  it('adds react-dom/client alias for react-dom peer', () => {
    const clientDir = join(tmpDir, 'node_modules', 'react-dom', 'client')
    setupProject({
      pdsConfig: {
        dependencies: {
          'my-dep': { localPath: 'my-dep' },
        },
      },
      localDeps: {
        'my-dep': {
          peerDependencies: { 'react-dom': '^18.0.0' },
        },
      },
      installedModules: ['react-dom'],
    })
    mkdirSync(clientDir, { recursive: true })
    const plugin = pdsPlugin({ root: tmpDir })
    const result = plugin.config()
    expect(result).toBeDefined()
    const aliases = result!.resolve.alias
    expect(aliases['react-dom']).toBe(join(tmpDir, 'node_modules', 'react-dom'))
    expect(aliases['react-dom/client']).toBe(clientDir)
  })

  it('skips peers not installed in consumer', () => {
    setupProject({
      pdsConfig: {
        dependencies: {
          'my-dep': { localPath: 'my-dep' },
        },
      },
      localDeps: {
        'my-dep': {
          peerDependencies: { 'installed-peer': '^1.0.0', 'missing-peer': '^2.0.0' },
        },
      },
      installedModules: ['installed-peer'],
    })
    const plugin = pdsPlugin({ root: tmpDir })
    const result = plugin.config()
    expect(result).toBeDefined()
    const aliases = result!.resolve.alias
    expect(aliases['installed-peer']).toBeDefined()
    expect(aliases['missing-peer']).toBeUndefined()
  })

  it('merges peers from multiple local deps', () => {
    setupProject({
      pdsConfig: {
        dependencies: {
          'dep-a': { localPath: 'dep-a' },
          'dep-b': { localPath: 'dep-b' },
        },
      },
      localDeps: {
        'dep-a': { peerDependencies: { 'lib-x': '^1.0.0' } },
        'dep-b': { peerDependencies: { 'lib-y': '^2.0.0' } },
      },
      installedModules: ['lib-x', 'lib-y'],
    })
    const plugin = pdsPlugin({ root: tmpDir })
    const result = plugin.config()
    expect(result).toBeDefined()
    const aliases = result!.resolve.alias
    expect(aliases['lib-x']).toBeDefined()
    expect(aliases['lib-y']).toBeDefined()
  })

  it('supports extra option for additional aliases', () => {
    setupProject({
      pdsConfig: {
        dependencies: {
          'my-dep': { localPath: 'my-dep' },
        },
      },
      localDeps: {
        'my-dep': { peerDependencies: {} },
      },
      installedModules: ['plotly.js-dist-min'],
    })
    const plugin = pdsPlugin({ root: tmpDir, extra: ['plotly.js-dist-min'] })
    const result = plugin.config()
    expect(result).toBeDefined()
    expect(result!.resolve.alias['plotly.js-dist-min']).toBe(
      join(tmpDir, 'node_modules', 'plotly.js-dist-min')
    )
  })

  describe('CJS compat', () => {
    it('includes local deps in optimizeDeps.include', () => {
      setupProject({
        pdsConfig: {
          dependencies: {
            'my-dep': { localPath: 'my-dep' },
          },
        },
        localDeps: {
          'my-dep': { peerDependencies: {} },
        },
      })
      const plugin = pdsPlugin({ root: tmpDir })
      const result = plugin.config()
      expect(result).toBeDefined()
      expect(result!.optimizeDeps).toEqual({ include: ['my-dep'] })
    })

    it('includes multiple local deps in optimizeDeps.include', () => {
      setupProject({
        pdsConfig: {
          dependencies: {
            'dep-a': { localPath: 'dep-a' },
            'dep-b': { localPath: 'dep-b' },
            'dep-c': { github: 'user/repo' },
          },
        },
        localDeps: {
          'dep-a': {},
          'dep-b': {},
        },
      })
      const plugin = pdsPlugin({ root: tmpDir })
      const result = plugin.config()
      expect(result).toBeDefined()
      expect(result!.optimizeDeps!.include).toEqual(['dep-a', 'dep-b'])
    })

    it('defines global shim for CJS local deps (no type field)', () => {
      setupProject({
        pdsConfig: {
          dependencies: {
            'my-dep': { localPath: 'my-dep' },
          },
        },
        localDeps: {
          'my-dep': {},
        },
      })
      const plugin = pdsPlugin({ root: tmpDir })
      const result = plugin.config()
      expect(result).toBeDefined()
      expect(result!.define).toEqual({ global: 'globalThis' })
    })

    it('defines global shim when type is "commonjs"', () => {
      setupProject({
        pdsConfig: {
          dependencies: {
            'my-dep': { localPath: 'my-dep' },
          },
        },
        localDeps: {
          'my-dep': { type: 'commonjs' },
        },
      })
      const plugin = pdsPlugin({ root: tmpDir })
      const result = plugin.config()
      expect(result).toBeDefined()
      expect(result!.define).toEqual({ global: 'globalThis' })
    })

    it('skips global shim when all local deps are ESM', () => {
      setupProject({
        pdsConfig: {
          dependencies: {
            'my-dep': { localPath: 'my-dep' },
          },
        },
        localDeps: {
          'my-dep': { type: 'module' },
        },
      })
      const plugin = pdsPlugin({ root: tmpDir })
      const result = plugin.config()
      expect(result).toBeDefined()
      expect(result!.define).toBeUndefined()
    })

    it('defines global shim when at least one local dep is CJS', () => {
      setupProject({
        pdsConfig: {
          dependencies: {
            'esm-dep': { localPath: 'esm-dep' },
            'cjs-dep': { localPath: 'cjs-dep' },
          },
        },
        localDeps: {
          'esm-dep': { type: 'module' },
          'cjs-dep': {},
        },
      })
      const plugin = pdsPlugin({ root: tmpDir })
      const result = plugin.config()
      expect(result).toBeDefined()
      expect(result!.define).toEqual({ global: 'globalThis' })
    })

    it('does not set optimizeDeps or define when no local deps', () => {
      setupProject({
        pdsConfig: {
          dependencies: {
            'my-dep': { github: 'user/repo' },
          },
        },
      })
      const plugin = pdsPlugin({ root: tmpDir })
      const result = plugin.config()
      expect(result).toBeUndefined()
    })
  })
})
