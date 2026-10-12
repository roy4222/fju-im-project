/**
 * 容量的顯示字（第三波 W5；方案 §10「MiB／GiB／KiB → MB／GB／KB」）。
 *
 * **採二進位**：1 KB＝1024 B、1 MB＝1024 KB，跟作業系統檔案總管與既有上限設定
 * （欄位設定用整數 MiB、`storage.ts` 的 GiB）同一套換算，只把單位寫成大家熟悉的 KB／MB／GB。
 * 取到小數一位、去掉多餘的「.0」；四捨五入後到 1024 就換下一個單位。
 *
 * 放在 shared：伺服器頁面與 Client Component（上傳表單）都要用同一套字。
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (unit < UNITS.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${shown} ${UNITS[unit]}`
}
