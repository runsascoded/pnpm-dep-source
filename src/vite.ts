import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

import { CONFIG_FILES } from './constants.js'

interface PdsVitePluginOptions {
  /** Path to project root (default: process.cwd()) */
  root?: string
  /** Extra modules to always alias to consumer's node_modules */
  extra?: string[]
}

interface LocalDepInfo {
  name: string
  localPath: string
  pkg: Record<string, unknown>
  isCJS: boolean
}

interface PdsPluginConfig {
  resolve: { alias: Record<string, string> }
  optimizeDeps?: { include: string[] }
  define?: Record<string, string>
}

/**
 * Vite plugin that auto-manages resolve aliases, optimizeDeps, and CJS compat
 * for pds local deps. Prevents duplicate React instances, unresolved peer imports
 * across symlink boundaries, and CJS require() failures in the browser.
 */
export function pdsPlugin(options?: PdsVitePluginOptions): {
  name: string
  config: () => PdsPluginConfig | undefined
} {
  const root = options?.root ?? process.cwd()
  return {
    name: 'pds-resolve',
    config() {
      const configPath = CONFIG_FILES.map(f => resolve(root, f)).find(existsSync)
      if (!configPath) return undefined
      let config: { dependencies?: Record<string, { localPath?: string }> }
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        return undefined
      }
      if (!config.dependencies) return undefined

      const aliases: Record<string, string> = {}
      const localDeps: LocalDepInfo[] = []

      for (const [name, dep] of Object.entries(config.dependencies)) {
        if (!dep.localPath) continue
        const localPkgPath = resolve(root, dep.localPath, 'package.json')
        if (!existsSync(localPkgPath)) continue
        let localPkg: Record<string, unknown>
        try {
          localPkg = JSON.parse(readFileSync(localPkgPath, 'utf-8'))
        } catch {
          continue
        }
        const isCJS = !localPkg.type || localPkg.type !== 'module'
        localDeps.push({ name, localPath: dep.localPath, pkg: localPkg, isCJS })

        const peers = Object.keys((localPkg.peerDependencies ?? {}) as Record<string, string>)
        for (const peer of peers) {
          const resolved = resolve(root, 'node_modules', peer)
          if (!existsSync(resolved)) continue
          aliases[peer] = resolved
          if (peer === 'react') {
            const jsxRuntime = resolve(resolved, 'jsx-runtime')
            if (existsSync(jsxRuntime)) {
              aliases['react/jsx-runtime'] = jsxRuntime
            }
          }
          if (peer === 'react-dom') {
            const client = resolve(resolved, 'client')
            if (existsSync(client)) {
              aliases['react-dom/client'] = client
            }
          }
        }
      }

      if (options?.extra) {
        for (const mod of options.extra) {
          const resolved = resolve(root, 'node_modules', mod)
          if (existsSync(resolved)) {
            aliases[mod] = resolved
          }
        }
      }

      if (localDeps.length === 0 && Object.keys(aliases).length === 0) return undefined

      const result: PdsPluginConfig = { resolve: { alias: aliases } }

      // Auto-include local deps in optimizeDeps so Vite pre-bundles them (CJS→ESM)
      if (localDeps.length > 0) {
        result.optimizeDeps = { include: localDeps.map(d => d.name) }
      }

      // Auto-define Node.js globals for CJS local deps
      if (localDeps.some(d => d.isCJS)) {
        result.define = {
          global: 'globalThis',
        }
      }

      return result
    },
  }
}
