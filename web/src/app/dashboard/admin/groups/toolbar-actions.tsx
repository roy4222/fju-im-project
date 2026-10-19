'use client'
import { useState, type ComponentType } from 'react'
import { DIALOG, PRIMARY, SECONDARY } from '@/app/dashboard/admin/groups/admin-group-forms'
import type { GroupImportActions, GroupImportLook } from '@/app/dashboard/admin/groups/import-dialog'
import { groupImportAction } from '@/app/dashboard/admin/groups/import-actions'

type ImportDialog = ComponentType<{
  cohortId: string
  cohortLabel: string
  actions: GroupImportActions
  look: GroupImportLook
  onClose: () => void
}>

/**
 * Server Action（只有一個 `groupImportAction`）與樣式字串從這裡傳進對話框（本頁首載本來就有 `admin-group-forms`
 * 與 Server Action 的執行期），延後載入的對話框 chunk 只依賴 React 與小工具，Turbopack 才不會把全站共用的 chunk
 * 重新切開（實測直接 import 時 `$shared` +1.3 KB）。
 */
const LOOK: GroupImportLook = { dialog: DIALOG, primary: PRIMARY, secondary: SECONDARY }

/**
 * 「全部組別」分頁列右側的三顆：「匯入」「匯出」「分組設定」（設計方案③ §6.1；C3-16 建、C3-12 掛進分頁列 `actions`）。
 *
 * 本票先放「匯入」（§6.4）：按下去才用 `import()` 載入對話框（含預覽表、結果表），不進頁面首載；
 * 不用 `next/dynamic`：它的執行期也會被併進全站共用 chunk。「匯出」（既有 CSV／XLSX 選單）與「分組設定」（既有齒輪鈕）
 * 還在頁面原本的位置，C3-12 重寫頁面時搬進來（這裡的首載每多一點都算在「全部組別」頭上，先不留空的插槽）。
 */
export function ToolbarActions({ cohortId, cohortLabel }: { cohortId: string; cohortLabel: string }) {
  // 關閉時卸載，下次再開是全新狀態（從選檔開始）。
  const [Dialog, setDialog] = useState<ImportDialog | null>(null)
  return (
    <>
      <button
        type="button"
        className={SECONDARY}
        onClick={() => import('./import-dialog').then((m) => setDialog(() => m.GroupImportDialog))}
      >
        匯入
      </button>
      {Dialog ? (
        <Dialog cohortId={cohortId} cohortLabel={cohortLabel} actions={groupImportAction} look={LOOK} onClose={() => setDialog(null)} />
      ) : null}
    </>
  )
}
