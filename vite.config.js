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
      name: 'copy-player-assets',
      writeBundle() {
        const filesToCopy = [
          ['player.js', 'player.js'],
          ['service-worker.js', 'service-worker.js'],
          ['vision_logo.png', 'vision_logo.png'],
          ['icon-192.png', 'icon-192.png'],
          ['icon-512.png', 'icon-512.png'],
        ];

        for (const [sourceName, targetName] of filesToCopy) {
          const sourcePath = resolve(__dirname, sourceName);
          const targetPath = resolve(__dirname, 'dist', targetName);
          if (!existsSync(sourcePath)) continue;
          copyFileSync(sourcePath, targetPath);
          console.log(`[build] ${sourceName} copiado para dist/${targetName}`);
        }
      }
    }
  ]
});
