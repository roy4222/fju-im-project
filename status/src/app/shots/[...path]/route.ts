/**
 * 驗收截圖：`/shots/<runId>/<item>/screenshots/<檔名>`（設計方案 §3.9）。
 *
 * 只服務該 run 的 summary.json 有列到的檔；網址形狀不對、runId 不在 acceptance-index、
 * 沒列到、檔案不在那夜的目錄裡（含 symlink 指出去），一律 404 且內文不說原因。
 * Access JWT 由 src/proxy.ts 先擋（/shots/* 在範圍內）。
 */
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { acceptanceDir, readData, readSummaryJson } from '@/lib/data/read'
import { listedShots, parseShotPath } from '@/lib/map/shots'

const notFound = () =>
  new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })

export async function GET(_request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const shot = parseShotPath((await ctx.params).path)
  if (!shot) return notFound()

  const index = await readData('acceptance-index.json')
  if (index.status !== 'ok' || !index.data.runs?.some((r) => r.runId === shot.runId)) return notFound()

  const summary = await readSummaryJson(shot.runId)
  if (summary.status !== 'ok' || !listedShots(summary.data).has(shot.rel)) return notFound()

  try {
    const runDir = await realpath(path.join(acceptanceDir(), shot.runId))
    const file = await realpath(path.join(runDir, shot.rel))
    if (!file.startsWith(runDir + path.sep)) return notFound()
    const body = await readFile(file)
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': shot.contentType,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch {
    return notFound()
  }
}
