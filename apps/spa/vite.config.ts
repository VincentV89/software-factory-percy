import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is served from S3 behind CloudFront; /api, /auth and /u are proxied to the local server in dev.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, cssCodeSplit: false },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4173', '/auth': 'http://localhost:4173', '/u': 'http://localhost:4173', '/_local': 'http://localhost:4173' } },
});
