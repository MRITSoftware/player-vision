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

        // Copiar ícones usados por PWA/Capacitor para a raiz do dist
        const icon192Path = resolve(__dirname, 'icon-192.png');
        const icon192DistPath = resolve(__dirname, 'dist', 'icon-192.png');
        if (existsSync(icon192Path)) {
          copyFileSync(icon192Path, icon192DistPath);
          console.log('✅ icon-192.png copiado para dist/');
        }

        const icon512Path = resolve(__dirname, 'icon-512.png');
        const icon512DistPath = resolve(__dirname, 'dist', 'icon-512.png');
        if (existsSync(icon512Path)) {
          copyFileSync(icon512Path, icon512DistPath);
          console.log('✅ icon-512.png copiado para dist/');
        }
      }
    }
  ]
});
