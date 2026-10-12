/**
 * 驗收截圖：`/shots/<runId>/<item>/screenshots/<檔名>`（設計方案 §3.9）。
 *
 * 只服務該 run 的 summary.json 有列到的檔；網址形狀不對、runId 不在 acceptance-index、
 * 沒列到、路徑上任何一段是 symlink、最後不是一般檔案或是硬連結，一律 404 且內文不說原因。
 * Access JWT 由 src/proxy.ts 先擋（/shots/* 在範圍內）。
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { acceptanceDir, readData, readSummaryJson } from '@/lib/data/read'
import { listedShots, parseShotPath } from '@/lib/map/shots'

const notFound = () =>
  new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })

/**
 * 以 acceptance 的真實目錄為邊界，逐段 lstat：runId、item、screenshots 都要是真的目錄、
 * 檔名要是一般檔案且只有一個連結（`nlink === 1`），**任何一段是 symlink、或最後的檔案是硬連結
 * 就拒絕**（不然列到的圖可以連到同夜的 run.json，或連到 acceptance 外面）。
 * 最後再用 realpath 確認仍在邊界內。不符回 null。
 */
async function openListedFile(root: string, segments: string[]): Promise<string | null> {
  const base = await realpath(root)
  let current = base
  for (const [i, segment] of segments.entries()) {
    current = path.join(current, segment)
    const st = await lstat(current)
    if (st.isSymbolicLink()) return null
    if (i < segments.length - 1) {
      if (!st.isDirectory()) return null
    } else if (!st.isFile() || st.nlink !== 1) {
      // 硬連結（nlink > 1）看起來是一般檔案，卻可能是同夜 run.json 或 acceptance 外的檔案。
      return null
    }
  }
  const resolved = await realpath(current)
  return resolved.startsWith(base + path.sep) ? resolved : null
}

export async function GET(_request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const shot = parseShotPath((await ctx.params).path)
  if (!shot) return notFound()

  const index = await readData('acceptance-index.json')
  if (index.status !== 'ok' || !index.data.runs?.some((r) => r.runId === shot.runId)) return notFound()

  const summary = await readSummaryJson(shot.runId)
  if (summary.status !== 'ok' || !listedShots(summary.data).has(shot.rel)) return notFound()

  try {
    const file = await openListedFile(acceptanceDir(), [shot.runId, ...shot.rel.split('/')])
    if (!file) return notFound()
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
