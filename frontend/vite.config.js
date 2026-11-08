import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The browser always calls the relative `/api` base. During local development
// Vite forwards those requests to the backend so cookies/CSRF stay same-origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_DEV_API_PROXY || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
