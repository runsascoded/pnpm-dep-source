import { describe, expect, it } from 'vitest'

import type { Config } from '../src/types.js'
import { findAllMatchingDeps } from '../src/config.js'

const config: Config = {
  dependencies: {
    '@slidev/cli': { github: 'Open-Athena/slidev', npm: '@slidev/cli' },
    '@slidev/client': { github: 'Open-Athena/slidev', npm: '@slidev/client' },
    '@slidev/parser': { github: 'Open-Athena/slidev', npm: '@slidev/parser' },
    '@slidev/types': { github: 'Open-Athena/slidev', npm: '@slidev/types' },
    'use-kbd': { github: 'runsascoded/use-kbd', npm: 'use-kbd' },
  },
}

function names(query: string): string[] {
  return findAllMatchingDeps(config, query).map(([name]) => name)
}

describe('findAllMatchingDeps', () => {
  it('matches all deps containing a base substring', () => {
    expect(names('slidev')).toEqual([
      '@slidev/cli',
      '@slidev/client',
      '@slidev/parser',
      '@slidev/types',
    ])
  })

  it('is case-insensitive', () => {
    expect(names('SLIDEV')).toEqual([
      '@slidev/cli',
      '@slidev/client',
      '@slidev/parser',
      '@slidev/types',
    ])
  })

  it('treats the query as a regex (unanchored)', () => {
    // "cli" matches both @slidev/cli and @slidev/client (client contains "cli")
    expect(names('cli')).toEqual(['@slidev/cli', '@slidev/client'])
  })

  it('supports anchoring with $ to exclude overlapping names', () => {
    expect(names('cli$')).toEqual(['@slidev/cli'])
  })

  it('supports alternation', () => {
    expect(names('(parser|types)$')).toEqual(['@slidev/parser', '@slidev/types'])
  })

  it('preserves config insertion order', () => {
    expect(names('@slidev/')).toEqual([
      '@slidev/cli',
      '@slidev/client',
      '@slidev/parser',
      '@slidev/types',
    ])
  })

  it('throws on a pattern that matches nothing', () => {
    expect(() => findAllMatchingDeps(config, 'nonexistent')).toThrow(
      'No dependency matching /nonexistent/ found in config',
    )
  })

  it('throws on an invalid regex', () => {
    expect(() => findAllMatchingDeps(config, '[')).toThrow(/Invalid pattern "\["/)
  })
})
