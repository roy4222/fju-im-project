#!/usr/bin/env node
/**
 * 計數用的假 origin（設計方案 §3.12 第 7b 步、AC-S-25 c）。
 *
 * 安裝腳本在刪 cert.pem 前，用一條暫時隧道驗證「隧道端驗 JWT」這道鎖真的會擋：
 * 從外面打 /probe，再從暫時網路裡讀 /count，計數是 0 才代表請求沒穿過隧道。
 *
 *   GET /probe → 計數加一，回 204
 *   GET /count → 回目前計數（純文字），**不加**計數
 *   其他方法或路徑 → 404，不加計數
 *
 * 零依賴，跟 status-web 同一個映像：`node verify-origin.mjs`（埠號 VERIFY_ORIGIN_PORT，預設 8080）。
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export function createVerifyOrigin() {
  let count = 0
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://origin.invalid').pathname
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'GET' && path === '/probe') {
      count += 1
      res.writeHead(204).end()
      return
    }
    if (req.method === 'GET' && path === '/count') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`${count}\n`)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n')
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.VERIFY_ORIGIN_PORT ?? 8080)
  const server = createVerifyOrigin()
  server.listen(port, '0.0.0.0', () => console.log(`verify-origin 在 :${port} 等待 /probe 與 /count`))
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)))
}
