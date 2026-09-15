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
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
}

export default nextConfig
