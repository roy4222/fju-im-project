import type { NextConfig } from 'next'

// status/ 是獨立專案（不在 pnpm workspace、自己的 lockfile），根目錄就是這一層。
// 明講 root，否則 Next 看到 repo 根目錄的 pnpm-lock.yaml 會把整個 repo 當成 workspace 根，
// standalone 產物就會變成 status/server.js 這種巢狀路徑。
const appRoot = import.meta.dirname

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 映像跑 standalone 產物（Dockerfile 只複製必要檔案；設計方案 §3.6）。
  output: 'standalone',
  turbopack: { root: appRoot },
  outputFileTracingRoot: appRoot,
  poweredByHeader: false,
  // 本機開發用的假資料不進正式映像（正式模式讀 /data、/acceptance）。
  outputFileTracingExcludes: { '*': ['fixtures/**'] },
}

export default nextConfig
