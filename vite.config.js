import { defineConfig } from 'vite';
import { copyFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: './index.html'
      }
    }
  },
  server: {
    port: 5173,
    host: true
  },
  plugins: [
    {
      name: 'copy-player-js',
      writeBundle() {
        // Copiar player.js para a raiz do dist após o build
        const playerJsPath = resolve(__dirname, 'player.js');
        const distPath = resolve(__dirname, 'dist', 'player.js');
        if (existsSync(playerJsPath)) {
          copyFileSync(playerJsPath, distPath);
          console.log('✅ player.js copiado para dist/');
        }
        
        // Copiar vision_logo.png para a raiz do dist (necessário para o Capacitor Splash Screen)
        const visionLogoPath = resolve(__dirname, 'vision_logo.png');
        const visionLogoDistPath = resolve(__dirname, 'dist', 'vision_logo.png');
        if (existsSync(visionLogoPath)) {
          copyFileSync(visionLogoPath, visionLogoDistPath);
          console.log('✅ vision_logo.png copiado para dist/');
        }
      }
    }
  ]
});
