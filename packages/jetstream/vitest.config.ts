import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite 8's oxc transform doesn't lower standard (TC39) decorators, so importing any
  // src/actions/* module in a test is a Node syntax error without this. Legacy lowering
  // is behaviour-identical for the SDK's @action decorator (it returns a subclass and
  // ignores the context argument). The shipped bundle (scripts/build.mjs) is unaffected:
  // it uses esbuild, which lowers the standard form for target node20.
  oxc: { decorator: { legacy: true } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
