import { defineConfig } from 'tsdown'

/** Build the standalone server plugin while keeping DSH services external. */
export default defineConfig({
  entry: { index: './.build/host/index.js' },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-fs',
      '@deepseek-ai/dsh-workspace',
      '@deepseek-ai/dsh-subprocess',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/schemastery',
    ],
  },
})
