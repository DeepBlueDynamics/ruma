import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/tests/setup.ts'],
    // Node, not jsdom: nothing under test touches the DOM beyond `localStorage`,
    // which setup.ts shims. Keep it that way — a test that needs a real DOM is a
    // test that has strayed out of the pure layer.
    environment: 'node',
  },
});
