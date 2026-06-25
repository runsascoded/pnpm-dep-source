import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      'node_modules/**',
      'test/e2e/**',  // e2e tests run in Docker only
    ],
    // Many round-trip tests spawn the built CLI (`node dist/cli.js`) dozens of
    // times; under parallel load the default 5s timeout is too tight and flakes.
    testTimeout: 30000,
  },
})
