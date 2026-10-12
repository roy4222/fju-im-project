// fetch 加逾時與一致的錯誤訊息。錯誤訊息只帶狀態碼與網址路徑，不帶回應內容。
import { scrubIp } from './redact.mjs'

export class HttpError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function describe(url) {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return String(url)
  }
}

export async function fetchRaw(url, { timeoutMs = 15000, headers = {}, redirect = 'follow' } = {}) {
  try {
    return await fetch(url, { headers, redirect, signal: globalThis.AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const cause = err?.cause?.code ?? err?.cause?.message ?? err?.name ?? 'error'
    throw new HttpError(scrubIp(`連不到 ${describe(url)}（${cause}）`), 0)
  }
}

export async function fetchJson(url, options) {
  const res = await fetchRaw(url, options)
  if (!res.ok) throw new HttpError(`${describe(url)} 回 HTTP ${res.status}`, res.status)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(`${describe(url)} 回的不是合法的 JSON`, res.status)
  }
}
