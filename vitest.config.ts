import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // One file at a time: the hook's and the lock's suites time processes
    // and timers, which the parsing and sending suites would starve.
    fileParallelism: false,
  },
});
