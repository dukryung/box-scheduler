import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // In dev, forward API calls to the admin server (docker compose exposes it on 8090).
    proxy: { '/api': 'http://localhost:8090' },
    fs: { allow: ['..'] },
  },
})
