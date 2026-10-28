import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on the LAN too, so phones on the same Wi-Fi can load the dev
    // server. Use the .local name rather than the IP: it's the origin the
    // API and bucket CORS rules allow (see FRONTEND_ORIGINS in cdk/app.py).
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: ['jamess-macbook-pro.local'],
  },
})
