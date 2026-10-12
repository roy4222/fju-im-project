/**
 * 讀 collector 輸出（STATUS_DATA_DIR）與驗收結果（STATUS_ACCEPTANCE_DIR）。
 *
 * 只讀不寫。檔案不存在、不是合法 JSON、不是物件都不丟例外，回一個畫面能直接顯示的狀態，
 * 讓「資料不夠」顯示成灰色而不是整頁壞掉。
 *
 * 目錄：正式模式預設 `/data`、`/acceptance`（compose 唯讀掛載）；本機開發沒設時讀 `fixtures/base/`。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { DataFileName, DataFiles, RunJson, SummaryJson } from './types'

export type ReadResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'missing' }
  | { status: 'invalid'; error: string }

const fixturesBase = () => path.join(process.cwd(), 'fixtures', 'base')

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STATUS_DATA_DIR) return env.STATUS_DATA_DIR
  return env.NODE_ENV === 'production' ? '/data' : path.join(fixturesBase(), 'data')
}

export function acceptanceDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STATUS_ACCEPTANCE_DIR) return env.STATUS_ACCEPTANCE_DIR
  return env.NODE_ENV === 'production' ? '/acceptance' : path.join(fixturesBase(), 'acceptance')
}

/** 路徑每段只收 `^[A-Za-z0-9._-]+$`，且不是 `.`／`..`（§3.9 截圖路由同規則）。 */
const SEGMENT = /^[A-Za-z0-9._-]+$/
export function isSafeSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== '.' && segment !== '..'
}

export async function readJsonFile<T>(file: string): Promise<ReadResult<T>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', error: `讀不到：${(err as Error).message}` }
  }
  try {
    const data: unknown = JSON.parse(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { status: 'invalid', error: '不是 JSON 物件' }
    }
    return { status: 'ok', data: data as T }
  } catch (err) {
    return { status: 'invalid', error: `JSON 格式錯誤：${(err as Error).message}` }
  }
}

/** 讀 collector 的一個輸出檔，例如 `readData('github.json')`、`readData('repo/tickets.json')`。 */
export function readData<K extends DataFileName>(name: K, env?: NodeJS.ProcessEnv): Promise<ReadResult<DataFiles[K]>> {
  return readJsonFile<DataFiles[K]>(path.join(dataDir(env), name))
}

async function readRunFile<T>(runId: string, file: string, env?: NodeJS.ProcessEnv): Promise<ReadResult<T>> {
  if (!isSafeSegment(runId)) return { status: 'invalid', error: 'runId 格式不對' }
  return readJsonFile<T>(path.join(acceptanceDir(env), runId, file))
}

/** 一夜驗收的 run.json（每夜一定有）。 */
export const readRunJson = (runId: string, env?: NodeJS.ProcessEnv) => readRunFile<RunJson>(runId, 'run.json', env)

/** 一夜驗收的 summary.json（可能沒有）。 */
export const readSummaryJson = (runId: string, env?: NodeJS.ProcessEnv) =>
  readRunFile<SummaryJson>(runId, 'summary.json', env)

/** 只要資料、不在乎為什麼沒有時用（沒有就是 null）。 */
export const dataOrNull = <T>(result: ReadResult<T>): T | null => (result.status === 'ok' ? result.data : null)
