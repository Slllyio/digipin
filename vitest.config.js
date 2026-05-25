import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/playwright/**'],
  },
});
