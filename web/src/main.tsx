import { ThemeProvider } from '@hx/ui/theme';
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
// 默认暗色 (与 HX-UI 文档站一致), 侧栏里可以切亮色, 选择存在 localStorage 的 hx-theme
const render = (node: ReactNode) => root.render(<StrictMode><ThemeProvider defaultMode="dark">{node}</ThemeProvider></StrictMode>);

// 演示构建 (VITE_DEMO=1) 先装好浏览器内的模拟接口再渲染; 正常构建里这段会被整体移除
if (__DEMO__) void import('./demo').then((m) => m.boot(render, <App />));
else render(<App />);
