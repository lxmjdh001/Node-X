import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    cors: false,
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem}',
        '**/.git/**',
        '**/secrets.key',
        '**/nodex.sqlite*',
        '**/profiles/**',
        '**/server/**',
      ],
    },
  },
});
