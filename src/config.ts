import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

import type { Config, DepConfig, HooksConfig } from './types.js'
import { resolveConfigPath, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE, HOOKS_CONFIG_FILE } from './constants.js'

export function loadConfig(projectRoot: string): Config {
  const configPath = resolveConfigPath(projectRoot)
  if (!existsSync(configPath)) {
    return { dependencies: {} }
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

export function saveConfig(projectRoot: string, config: Config): void {
  const configPath = resolveConfigPath(projectRoot)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}

export function loadGlobalConfig(): Config {
  if (!existsSync(GLOBAL_CONFIG_FILE)) {
    return { dependencies: {} }
  }
  return JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, 'utf-8'))
}

export function saveGlobalConfig(config: Config): void {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
  }
  writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}

export function findMatchingDep(config: Config, query?: string): [string, DepConfig] {
  const deps = Object.entries(config.dependencies)

  if (!query) {
    // No query - default to single dep if there's exactly one
    if (deps.length === 0) {
      throw new Error('No dependencies configured. Use "pds init <path>" to add one.')
    }
    if (deps.length === 1) {
      return deps[0]
    }
    throw new Error(
      `Multiple dependencies configured. Specify one: ${deps.map(([n]) => n).join(', ')}`
    )
  }

  const queryLower = query.toLowerCase()

  // First, check for exact match (case-insensitive)
  const exactMatch = deps.find(([name]) => name.toLowerCase() === queryLower)
  if (exactMatch) {
    return exactMatch
  }

  // Fall back to substring matching
  const matches = deps.filter(([name]) =>
    name.toLowerCase().includes(queryLower)
  )
  if (matches.length === 0) {
    throw new Error(`No dependency matching "${query}" found in config`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous match "${query}" - matches: ${matches.map(([n]) => n).join(', ')}`
    )
  }
  return matches[0]
}

export function loadHooksConfig(): HooksConfig {
  if (!existsSync(HOOKS_CONFIG_FILE)) {
    return {}
  }
  return JSON.parse(readFileSync(HOOKS_CONFIG_FILE, 'utf-8'))
}

export function saveHooksConfig(config: HooksConfig): void {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
  }
  writeFileSync(HOOKS_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}
