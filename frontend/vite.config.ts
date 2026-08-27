import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Bind all interfaces, not localhost: when the dev server runs inside a
    // container, a 127.0.0.1 bind is unreachable from the host even with the
    // port published.
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:8081',
      '/ws': { target: 'ws://127.0.0.1:8081', ws: true },
      '/hyperia-api': {
        target: 'http://127.0.0.1:9800',
        rewrite: path => path.replace(/^\/hyperia-api/, '/api'),
      },
    },
  },
});
