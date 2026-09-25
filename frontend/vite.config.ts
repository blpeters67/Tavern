import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

declare const process: { env: Record<string, string | undefined> };

// In development the backend runs on :8080 and Vite proxies API, file and
// WebSocket traffic to it, so the browser only ever talks to one origin.
const backend = process.env.TAVERN_BACKEND ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true },
      '/cdn': { target: backend },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1600,
  },
});
