import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '德州计分',
        short_name: '德州计分',
        lang: 'zh-CN',
        display: 'standalone',
        theme_color: '#080b16',
        background_color: '#080b16',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp}'],
        runtimeCaching: [
          { urlPattern: /\/api\//, handler: 'NetworkOnly' },
          { urlPattern: /\/socket\.io\//, handler: 'NetworkOnly' }
        ]
      }
    })
  ]
});
