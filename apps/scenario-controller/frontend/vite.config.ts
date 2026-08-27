import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The console is served by the controller API from the same origin in the lab,
// so the dev proxy points at a locally running backend and production builds
// use relative /api paths.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.CONTROLLER_URL ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
