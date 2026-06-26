import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    // Трябва да съвпада точно със Site URL в Supabase Dashboard (Authentication →
    // URL Configuration) — WebAuthn проверява origin-а (вкл. порта) при passkey
    // verify, не само хоста. strictPort гърми грешка вместо тихо да премине на
    // друг порт, ако 3000 вече е заето — иначе пак ще се разминем.
    port: 3000,
    strictPort: true,
  },
});
