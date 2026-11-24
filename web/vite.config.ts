import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 开发时把接口代理到 wrangler dev (默认 8787); 构建产物输出到 ../dist/web, 由 Worker 的 Assets 直接返回
const API = process.env.API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@hx/ui-dist': fileURLToPath(new URL('./node_modules/@hx/ui/dist', import.meta.url)) } },
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    proxy: Object.fromEntries(['/api', '/f', '/s', '/dav'].map((p) => [p, { target: API, changeOrigin: true }])),
  },
});
