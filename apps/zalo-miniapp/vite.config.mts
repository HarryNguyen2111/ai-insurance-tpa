import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Browser-only synthetic prototype (#74). `base: ''` keeps asset URLs relative, which is what the
// Zalo Mini App host expects; `zmp-vite-plugin` / `zmp deploy` are only needed for a real Zalo app
// (see README "Cần ứng dụng Zalo thật").
export default defineConfig({
  base: '',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    target: 'es2019',
  },
});
