import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: './index.html'
      }
    },
    // Garantir que player.js seja copiado como está (não processado)
    copyPublicDir: true
  },
  server: {
    port: 5173,
    host: true
  },
  // Incluir player.js explicitamente no build
  assetsInclude: ['**/*.js']
});
