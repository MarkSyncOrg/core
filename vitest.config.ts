import { defineConfig } from 'vitest/config';

// Core modules (crypto, api client, sync) are pure TypeScript and run in Node,
// which provides the Web Crypto API used by the crypto module. No browser env needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/types/**'],
    },
  },
});
