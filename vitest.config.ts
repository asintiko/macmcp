import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The end-to-end tests run the compiled CLI.
    globalSetup: ['tests/helpers/build.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests spawn real processes and HTTP servers; isolate per file.
    pool: 'forks',
  },
});
