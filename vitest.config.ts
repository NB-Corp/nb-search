import { defineConfig } from 'vitest/config';
import './scripts/vitest-worker-diagnostics.mjs';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Bound file workers; concurrency tests still launch simultaneous CLI processes.
    maxWorkers: 2,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
