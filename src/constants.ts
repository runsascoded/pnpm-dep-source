import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Find package.json by walking up from current file
// (handles both dev mode where cli is in dist/, and dist branch where cli is at root)
export function findOwnPackageJson(): string {
  let dir = __dirname
  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.name === 'pnpm-dep-source') return pkgPath
    }
    dir = dirname(dir)
  }
  throw new Error('Could not find pnpm-dep-source package.json')
}

const pkgJson = JSON.parse(readFileSync(findOwnPackageJson(), 'utf-8'))
export const VERSION = pkgJson.version as string

export const CONFIG_FILES = ['.pds.json', '.pnpm-dep-source.json']

export function resolveConfigPath(projectRoot: string): string {
  for (const f of CONFIG_FILES) {
    const p = join(projectRoot, f)
    if (existsSync(p)) return p
  }
  return join(projectRoot, CONFIG_FILES[0])
}

export const GLOBAL_CONFIG_DIR = join(homedir(), '.config', 'pnpm-dep-source')
export const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json')
export const GLOBAL_HOOKS_DIR = join(GLOBAL_CONFIG_DIR, 'hooks')
export const HOOKS_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'hooks.json')

// Common subdirectories where JS projects might live
export const JS_PROJECT_SUBDIRS = ['www', 'web', 'app', 'frontend', 'client', 'packages', 'src']

// ANSI color codes (only used when stdout is TTY)
export const isTTY = process.stdout.isTTY
export const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  red: isTTY ? '\x1b[31m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
}
