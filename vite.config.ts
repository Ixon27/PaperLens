import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{
      // 8.1.0 renders a highlight once PER LINE on each page; keep one instance per page.
      find: /^\.\.\/lib\/group-highlights-by-page$/,
      replacement: new URL('./src/web/pdf/group-highlights-by-page.ts', import.meta.url).pathname,
    }],
  },
  // Let Vite resolve the relative internal-helper alias instead of bundling it into the dependency cache.
  optimizeDeps: {
    exclude: ['react-pdf-highlighter-extended'],
    include: ['lodash.debounce', 'react-rnd'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // regex key: a plain '/api' prefix would also swallow the module '/api.ts'
      '^/api/': { target: 'http://127.0.0.1:4317', changeOrigin: false },
    },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
});
