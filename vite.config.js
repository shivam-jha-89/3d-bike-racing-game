import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // PORT is set by the preview harness when 5173 is taken by something else
  server: { port: Number(process.env.PORT) || 5173 },
});
