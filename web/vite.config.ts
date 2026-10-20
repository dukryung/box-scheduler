import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In dev, forward API calls to the Go server (docker compose exposes it on 8080).
    proxy: { '/api': 'http://localhost:8080' },
    // The theme tokens live in ../shared, next to the admin console.
    fs: { allow: ['..'] },
  },
})
