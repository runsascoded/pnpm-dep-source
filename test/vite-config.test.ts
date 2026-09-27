import { describe, expect, it } from 'vitest'

import { addOptimizeDepsExclude, removeOptimizeDepsExclude } from '../src/vite-config.js'

const DEP = '@test/dep'

const cfg = (body: string) => `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n${body}})\n`

interface RoundTrip {
  name: string
  before: string
  /** Exact file contents after `pds l` (add). */
  added: string
}

// Each case: add yields exactly `added`, and removing from `added` restores
// `before` byte-for-byte.
const ROUND_TRIPS: RoundTrip[] = [
  {
    name: 'no optimizeDeps (trailing-comma style)',
    before: cfg(`  plugins: [],\n`),
    added: cfg(`  plugins: [],\n  optimizeDeps: {\n    exclude: ['@test/dep'],\n  },\n`),
  },
  {
    name: 'no optimizeDeps, last property without trailing comma',
    before: cfg(`  server: {\n    port: 3201,\n  },\n  esbuild: {\n    logOverride: { 'x': 'silent' }\n  }\n`),
    added: cfg(`  server: {\n    port: 3201,\n  },\n  esbuild: {\n    logOverride: { 'x': 'silent' }\n  },\n  optimizeDeps: {\n    exclude: ['@test/dep'],\n  }\n`),
  },
  {
    name: 'preserves sibling `include` (the spec bug)',
    before: cfg(`  optimizeDeps: {\n    include: ['plotly.js/basic'],\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    include: ['plotly.js/basic'],\n    exclude: ['@test/dep'],\n  },\n`),
  },
  {
    name: 'preserves `include` when optimizeDeps is not the last property (jc-taxes shape)',
    before: cfg(`  optimizeDeps: {\n    include: ['@deck.gl/core', 'maplibre-gl'],\n  },\n\n  server: {\n    port: 3201,  // JC area code\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    include: ['@deck.gl/core', 'maplibre-gl'],\n    exclude: ['@test/dep'],\n  },\n\n  server: {\n    port: 3201,  // JC area code\n  },\n`),
  },
  {
    name: 'sibling with nested object (`esbuildOptions`)',
    before: cfg(`  optimizeDeps: {\n    esbuildOptions: {\n      target: 'es2020',\n    },\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    esbuildOptions: {\n      target: 'es2020',\n    },\n    exclude: ['@test/dep'],\n  },\n`),
  },
  {
    name: 'sibling without trailing comma',
    before: cfg(`  optimizeDeps: {\n    include: ['foo']\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    include: ['foo'],\n    exclude: ['@test/dep']\n  },\n`),
  },
  {
    name: 'single-line optimizeDeps',
    before: cfg(`  optimizeDeps: { include: ['foo'] },\n`),
    added: cfg(`  optimizeDeps: { include: ['foo'], exclude: ['@test/dep'] },\n`),
  },
  {
    name: 'existing single-line exclude with unrelated entries',
    before: cfg(`  optimizeDeps: {\n    include: ['foo'],\n    exclude: ['bar'],\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    include: ['foo'],\n    exclude: ['bar', '@test/dep'],\n  },\n`),
  },
  {
    name: 'single-line exclude with trailing comma',
    before: cfg(`  optimizeDeps: {\n    exclude: ['bar',],\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    exclude: ['bar', '@test/dep',],\n  },\n`),
  },
  {
    name: 'multi-line exclude (slidev shape)',
    before: cfg(`  optimizeDeps: {\n    exclude: [\n      'vue-demi',\n      '@vueuse/core',\n    ],\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    exclude: [\n      'vue-demi',\n      '@vueuse/core',\n      '@test/dep',\n    ],\n  },\n`),
  },
  {
    name: 'multi-line exclude without trailing comma',
    before: cfg(`  optimizeDeps: {\n    exclude: [\n      'vue-demi'\n    ],\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    exclude: [\n      'vue-demi',\n      '@test/dep'\n    ],\n  },\n`),
  },
  {
    name: 'multi-line exclude with comments (old apvd shape)',
    before: cfg(`  optimizeDeps: {\n    // WASM must never be pre-bundled\n    exclude: [\n      'apvd-wasm',      // WASM - always exclude\n      // pds\n    ],\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    // WASM must never be pre-bundled\n    exclude: [\n      'apvd-wasm',      // WASM - always exclude\n      // pds\n      '@test/dep',\n    ],\n  },\n`),
  },
  {
    name: 'comment-only exclude array is kept on removal',
    before: cfg(`  optimizeDeps: {\n    exclude: [\n      // pds-managed entries go here\n    ],\n  },\n`),
    added: cfg(`  optimizeDeps: {\n    exclude: [\n      // pds-managed entries go here\n      '@test/dep',\n    ],\n  },\n`),
  },
  {
    name: 'follows double-quote style',
    before: `import { defineConfig } from "vite"\n\nexport default defineConfig({\n  optimizeDeps: {\n    exclude: ["bar"],\n  },\n})\n`,
    added: `import { defineConfig } from "vite"\n\nexport default defineConfig({\n  optimizeDeps: {\n    exclude: ["bar", "@test/dep"],\n  },\n})\n`,
  },
  {
    name: 'does not touch vitest `test.exclude` or `ssr.optimizeDeps`',
    before: cfg(`  test: {\n    exclude: ['e2e/**'],\n  },\n  ssr: {\n    optimizeDeps: { include: ['x'] },\n  },\n`),
    added: cfg(`  test: {\n    exclude: ['e2e/**'],\n  },\n  ssr: {\n    optimizeDeps: { include: ['x'] },\n  },\n  optimizeDeps: {\n    exclude: ['@test/dep'],\n  },\n`),
  },
  {
    name: 'empty config object',
    before: `import { defineConfig } from 'vite'\n\nexport default defineConfig({})\n`,
    added: `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  optimizeDeps: {\n    exclude: ['@test/dep'],\n  },\n})\n`,
  },
  {
    name: 'arrow-function config',
    before: `import { defineConfig } from 'vite'\n\nexport default defineConfig(({ mode }) => ({\n  base: mode === 'production' ? '/app/' : '/',\n}))\n`,
    added: `import { defineConfig } from 'vite'\n\nexport default defineConfig(({ mode }) => ({\n  base: mode === 'production' ? '/app/' : '/',\n  optimizeDeps: {\n    exclude: ['@test/dep'],\n  },\n}))\n`,
  },
  {
    name: 'function config with block body',
    before: `import { defineConfig } from 'vite'\n\nexport default defineConfig(async () => {\n  const x = { server: {} }\n  return {\n    plugins: [],\n  }\n})\n`,
    added: `import { defineConfig } from 'vite'\n\nexport default defineConfig(async () => {\n  const x = { server: {} }\n  return {\n    plugins: [],\n    optimizeDeps: {\n      exclude: ['@test/dep'],\n    },\n  }\n})\n`,
  },
  {
    name: 'bare object export with `satisfies`',
    before: `import type { UserConfig } from 'vite'\n\nexport default {\n  plugins: [],\n} satisfies UserConfig\n`,
    added: `import type { UserConfig } from 'vite'\n\nexport default {\n  plugins: [],\n  optimizeDeps: {\n    exclude: ['@test/dep'],\n  },\n} satisfies UserConfig\n`,
  },
  {
    name: 'config via identifier',
    before: `import { defineConfig } from 'vite'\n\nconst config = {\n  plugins: [],\n}\n\nexport default defineConfig(config)\n`,
    added: `import { defineConfig } from 'vite'\n\nconst config = {\n  plugins: [],\n  optimizeDeps: {\n    exclude: ['@test/dep'],\n  },\n}\n\nexport default defineConfig(config)\n`,
  },
]

describe('optimizeDeps.exclude round-trips', () => {
  for (const { name, before, added } of ROUND_TRIPS) {
    it(name, () => {
      expect(addOptimizeDepsExclude(before, DEP)).toEqual({ content: added, status: 'changed' })
      expect(removeOptimizeDepsExclude(added, DEP)).toEqual({ content: before, status: 'changed' })
    })
  }
})

describe('addOptimizeDepsExclude', () => {
  it('is a no-op when the dep is already excluded (either quote style)', () => {
    for (const before of [
      cfg(`  optimizeDeps: {\n    exclude: ['@test/dep'],\n  },\n`),
      cfg(`  optimizeDeps: {\n    exclude: ["@test/dep"],\n  },\n`),
    ]) {
      expect(addOptimizeDepsExclude(before, DEP)).toEqual({ content: before, status: 'unchanged' })
    }
  })

  it('does not treat a subpath entry as the package', () => {
    const before = cfg(`  optimizeDeps: {\n    exclude: ['@test/dep/sub'],\n  },\n`)
    expect(addOptimizeDepsExclude(before, DEP).content).toBe(
      cfg(`  optimizeDeps: {\n    exclude: ['@test/dep/sub', '@test/dep'],\n  },\n`),
    )
  })

  it.each([
    ['non-literal exclude', `  optimizeDeps: {\n    exclude: excludes,\n  },\n`, '`optimizeDeps.exclude` is not an array literal'],
    ['non-literal optimizeDeps', `  optimizeDeps: optDeps,\n`, '`optimizeDeps` is not an object literal'],
    ['shorthand optimizeDeps', `  optimizeDeps,\n`, '`optimizeDeps` is a shorthand property'],
  ])('refuses to guess: %s', (_, body, reason) => {
    const before = cfg(body)
    expect(addOptimizeDepsExclude(before, DEP)).toEqual({ content: before, status: 'unsupported', reason })
  })

  it('reports a parse error without editing', () => {
    const before = `export default defineConfig({\n  plugins: [\n})\n`
    const result = addOptimizeDepsExclude(before, DEP)
    expect({ ...result, reason: result.reason?.replace(/:.*/s, ':') }).toEqual({
      content: before,
      status: 'unsupported',
      reason: 'parse error:',
    })
  })
})

describe('removeOptimizeDepsExclude', () => {
  it('is a no-op when the dep is absent', () => {
    for (const before of [
      cfg(`  plugins: [],\n`),
      cfg(`  optimizeDeps: {\n    include: ['foo'],\n  },\n`),
      cfg(`  optimizeDeps: {\n    exclude: ['bar'],\n  },\n`),
    ]) {
      expect(removeOptimizeDepsExclude(before, DEP)).toEqual({ content: before, status: 'unchanged' })
    }
  })

  it('removes a non-last entry', () => {
    expect(removeOptimizeDepsExclude(cfg(`  optimizeDeps: {\n    exclude: ['@test/dep', 'bar'],\n  },\n`), DEP).content)
      .toBe(cfg(`  optimizeDeps: {\n    exclude: ['bar'],\n  },\n`))
    expect(removeOptimizeDepsExclude(cfg(`  optimizeDeps: {\n    exclude: [\n      '@test/dep',\n      'bar',\n    ],\n  },\n`), DEP).content)
      .toBe(cfg(`  optimizeDeps: {\n    exclude: [\n      'bar',\n    ],\n  },\n`))
  })

  it('removes an entry\'s line along with its trailing comment, keeping other comments', () => {
    expect(removeOptimizeDepsExclude(cfg(`  optimizeDeps: {\n    exclude: [\n      '@test/dep',      // WASM - always exclude\n      // pds\n    ],\n  },\n`), DEP).content)
      .toBe(cfg(`  optimizeDeps: {\n    exclude: [\n      // pds\n    ],\n  },\n`))
  })

  it('removes a double-quoted entry', () => {
    expect(removeOptimizeDepsExclude(cfg(`  optimizeDeps: {\n    exclude: ["bar", "@test/dep"],\n  },\n`), DEP).content)
      .toBe(cfg(`  optimizeDeps: {\n    exclude: ["bar"],\n  },\n`))
  })

  it('never touches the dep name outside `optimizeDeps.exclude`', () => {
    const before = `import dep from '@test/dep'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  resolve: { alias: { '@test/dep': '/x' } },\n  test: { exclude: ['@test/dep'] },\n})\n`
    expect(removeOptimizeDepsExclude(before, DEP)).toEqual({ content: before, status: 'unchanged' })
  })

  it('round-trips two deps added and removed in either order', () => {
    const before = cfg(`  optimizeDeps: {\n    include: ['foo'],\n  },\n`)
    const both = addOptimizeDepsExclude(addOptimizeDepsExclude(before, 'a').content, 'b').content
    expect(both).toBe(cfg(`  optimizeDeps: {\n    include: ['foo'],\n    exclude: ['a', 'b'],\n  },\n`))
    expect(removeOptimizeDepsExclude(removeOptimizeDepsExclude(both, 'a').content, 'b').content).toBe(before)
    expect(removeOptimizeDepsExclude(removeOptimizeDepsExclude(both, 'b').content, 'a').content).toBe(before)
  })

  it('cleans up a block written by the old regex implementation', () => {
    // Old `pds l` into an existing block produced this (mis-indented) `exclude`.
    const legacy = cfg(`  optimizeDeps: {\n    include: ['foo'],\n        exclude: ['@test/dep'],\n  },\n`)
    expect(removeOptimizeDepsExclude(legacy, DEP).content).toBe(cfg(`  optimizeDeps: {\n    include: ['foo'],\n  },\n`))
  })
})
