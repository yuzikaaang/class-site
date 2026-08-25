import {createRoot} from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 注册 Service Worker，实现 PWA 可安装与离线兜底（仅生产环境生效）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(<App />)
