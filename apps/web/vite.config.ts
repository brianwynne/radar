import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// radar-web is a stateless static SPA. In development, Vite proxies /api to radar-api;
// in production, the reverse proxy / nginx routes /api (the NS1 key never reaches the
// browser — it lives only in radar-api).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
