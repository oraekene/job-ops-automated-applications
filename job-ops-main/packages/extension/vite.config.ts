import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'background.ts'),
        'content-script': resolve(__dirname, 'src/content-script.ts'),
        popup: resolve(__dirname, 'src/popup/index.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
    emptyOutDir: true,
  },
});
