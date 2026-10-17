import path from 'node:path'
import type { NextConfig } from 'next'

const appRoot = import.meta.dirname
// pnpm workspace：web/node_modules/next 是指向 repo 根 .pnpm store 的 symlink，
// Turbopack 的 root 要涵蓋 store，否則解析不到 next/package.json。
const workspaceRoot = path.join(appRoot, '..')

// 母 spec §4.3：不改 experimental.serverActions.bodySizeLimit
//（上傳走 Route Handler 串流，上限由 Caddy 管，契約 02 §6）。
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Compose 的 app 服務跑 standalone 產物（Dockerfile 只複製必要檔案）。
  output: 'standalone',
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  // 不送 `X-Powered-By: Next.js`（少洩一點版本資訊）。
  poweredByHeader: false,
  async headers() {
    return [
      {
        // 100 張預設頭像（`public/avatars/NNN.webp`）內容不會變，瀏覽器快取一天（SH-8）。
        // 上傳的頭像走 `/api/files/<id>`，快取規則在那支路由，不在這裡。
        source: '/avatars/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
      },
    ]
  },
}

export default nextConfig
