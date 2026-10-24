import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    // Audio fixtures launch FFmpeg; keep concurrent processes bounded on desktops.
    maxWorkers: 4,
  },
});
