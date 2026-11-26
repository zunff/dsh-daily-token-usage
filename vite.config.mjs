import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

const ID = '@local/daily-token-usage'

// The Web client only asks for one thing: a module that registers a lazy factory.
// Rollup emits CommonJS, then the banner hands its exports to the loader — which is
// exactly the contract every other client plugin follows.
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: [
      // JSX compiles to the automatic runtime; forward it to the host's React.
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL('./src/jsx-runtime.js', import.meta.url)) },
    ],
  },
  build: {
    target: 'es2020',
    emptyOutDir: true,
    outDir: 'dist',
    lib: {
      entry: 'src/main.jsx',
      formats: ['cjs'],
      fileName: () => 'client.js',
    },
    rollupOptions: {
      external: ['react'],
      output: {
        exports: 'named',
        banner: `window.__ModuleLoader__.load({
  id: '${ID}',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
`,
        footer: `
    return module.exports
  },
})
`,
      },
    },
  },
})
