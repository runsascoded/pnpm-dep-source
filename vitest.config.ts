import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      'node_modules/**',
      'test/e2e/**',  // e2e tests run in Docker only
    ],
  },
})
