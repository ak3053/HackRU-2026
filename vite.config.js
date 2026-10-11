import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// The triage server (main.py)
const API_TARGET = process.env.API_TARGET || 'http://localhost:8000';

export default defineConfig({
  // HTTPS (self-signed) because phones only allow GPS and the mesh's crypto on secure pages
  plugins: [react(), tailwindcss(), basicSsl()],
  server: {
    host: true, // reachable from other devices on the network, not just this machine
    // Same-origin calls to main.py: an HTTPS page may not call a plain-HTTP server directly
    proxy: {
      '/api': API_TARGET,
      '/ws': { target: API_TARGET, ws: true },
    },
  },
});
