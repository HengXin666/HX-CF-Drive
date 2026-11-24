import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 开发时把接口代理到 wrangler dev (默认 8787); 构建产物输出到 ../dist/web, 由 Worker 的 Assets 直接返回
const API = process.env.API ?? 'http://127.0.0.1:8787';
// VITE_DEMO=1: 纯前端演示站 (GitHub Pages), 接口全部在浏览器内模拟, 产物输出到 ../dist/demo
const DEMO = process.env.VITE_DEMO === '1';
const OUT = DEMO ? '../dist/demo' : '../dist/web';
const out = (f: string) => new URL(`${OUT}/${f}`, import.meta.url);

export default defineConfig({
  base: DEMO ? (process.env.DEMO_BASE ?? '/HX-CF-Drive/') : '/',
  define: { __DEMO__: JSON.stringify(DEMO) },
  plugins: [
    // 演示构建才让 Tailwind 扫描 src/demo, 正常构建的样式保持不变
    { name: 'demo-css', enforce: 'pre', transform: (code, id) => (DEMO && id.endsWith('/src/styles.css') ? code.replace('@source not "./demo";', '') : undefined) },
    react(),
    tailwindcss(),
    // 把仓库里的 Agent Skill 发布为 /skill.md, 部署后 Agent 可以直接读
    {
      name: 'copy-skill',
      closeBundle: () => {
        copyFileSync(new URL('../skills/hx-cf-drive/SKILL.md', import.meta.url), out('skill.md'));
        // Pages 没有服务端路由: /s/xxx, /f/xxx 等未知路径回落到 404.html, 由演示层接管
        if (DEMO) copyFileSync(out('index.html'), out('404.html'));
      },
    },
  ],
  resolve: { alias: { '@hx/ui-dist': fileURLToPath(new URL('./node_modules/@hx/ui/dist', import.meta.url)) } },
  build: { outDir: OUT, emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    proxy: Object.fromEntries(['/api', '/f', '/s', '/dav'].map((p) => [p, { target: API, changeOrigin: true }])),
  },
});
