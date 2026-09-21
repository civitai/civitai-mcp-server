import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // vi.restoreAllMocks() does NOT undo vi.stubGlobal, so without this a test
    // that forgets to stub fetch silently inherits the previous test's stub and
    // can pass without exercising what it claims to.
    unstubGlobals: true,
  },
});
