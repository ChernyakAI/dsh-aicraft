import { defineConfig } from 'tsdown'

// Match DSH's clientBundle protocol: shared modules come from its module
// table, and loading the bundle registers a lazy factory without executing it.
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  fixedExtension: false,
  platform: 'browser',
  tsconfig: 'tsconfig.client.json',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/dsh-client-ui-dockkit', '@deepseek-ai/dsh-client-ui-primitives'],
    alwaysBundle: ['zod'],
  },
  // Rolldown's region labels contain installation-dependent dependency paths.
  plugins: [{
    name: 'omit-region-labels',
    renderChunk(code) {
      return { code: code.replace(/^[ \t]*\/\/#(?:end)?region[^\r\n]*(?:\r?\n|$)/gm, ''), map: null }
    },
  }],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-aicraft", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
