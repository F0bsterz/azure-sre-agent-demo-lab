import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: process.env.MAGIC8BALL_URL ?? 'http://localhost:8080', changeOrigin: true },
      '/healthz': { target: process.env.MAGIC8BALL_URL ?? 'http://localhost:8080', changeOrigin: true },
    },
  },
});
