import fs from 'node:fs'
import path from 'node:path'
import { OUT_ROOT } from './helpers'

/**
 * 跑完掃一遍 `.out/`：任何檔案裡出現 E2E 管理員密碼就刪掉那個檔並讓整次失敗（同 ops/codex-e2e.sh 的洩漏檢查）。
 * 密碼只在記憶體裡比對，不印出來。
 */
export default function globalTeardown() {
  const password = process.env.E2E_ADMIN_PASSWORD
  if (!password || !fs.existsSync(OUT_ROOT)) return
  const needle = Buffer.from(password, 'utf8')
  const leaked: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && fs.readFileSync(full).includes(needle)) {
        fs.rmSync(full)
        leaked.push(path.relative(OUT_ROOT, full))
      }
    }
  }
  walk(OUT_ROOT)
  if (leaked.length > 0) {
    throw new Error(
      `輸出裡出現了 E2E 管理員密碼，已刪掉這些檔：${leaked.join('、')}。請在 Doppler stg 換一組 E2E_ADMIN_EMAIL＋E2E_ADMIN_PASSWORD，並到測試站後台停用舊的 E2E 測試管理員。`,
    )
  }
}
