import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig(({ mode }) => ({
  root: path.resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: path.resolve(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    minify: mode === 'production',
    target: 'chrome140',
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5199, strictPort: true },
}));
