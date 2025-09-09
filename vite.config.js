import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Simple Vite configuration for the Merck MMD simulator.
// This mirrors the structure used in the Collins prototype and enables
// React fast refresh in development.  Output is written to `dist` for
// deployment to Cloudflare Pages.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist'
  }
});