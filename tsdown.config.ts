import { defineConfig } from 'tsdown'

/**
 * Self-contained build: transpile src/ to ESM under lib/ without project
 * references or type checking. Peer packages stay external — the host's
 * loader resolves them from the profile's own node_modules.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'lib',
  clean: true,
  sourcemap: true,
  dts: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-launch-environment',
      '@deepseek-ai/dsh-settings',
    ],
  },
})
