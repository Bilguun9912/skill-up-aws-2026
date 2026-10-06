import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    // Structured request logs are noisy in test output; tests that assert on logs use spies.
    onConsoleLog: () => false,
  },
});
