import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/integration/**/*.test.ts', 'apps/local/test/**/*.test.ts', 'apps/spa/test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/domain/**/*.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 80 },
    },
  },
});
