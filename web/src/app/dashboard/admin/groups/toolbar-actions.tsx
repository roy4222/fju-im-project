import type { ReactNode } from 'react'
import { GroupImportDialog } from '@/app/dashboard/admin/groups/import-dialog'
import { GROUP_IMPORT_KIND_LABEL, GROUP_IMPORT_MAX_BYTES, GROUP_IMPORT_OUTCOME_LABEL } from '@/composition/groups'

/**
 * 「全部組別」分頁列右側的三顆：「匯入」「匯出」「分組設定」（設計方案③ §6.1；C3-16 建、C3-12 掛進分頁列 `actions`）。
 *
 * 「匯入」是本票的對話框（§6.4）。「匯出」（既有 CSV／XLSX 選單）與「分組設定」（既有齒輪鈕）還在頁面原本的位置，
 * C3-12 重寫頁面時由 `exportMenu`、`settings` 傳進來；沒傳就不畫。
 */
export function ToolbarActions({
  cohortId,
  cohortLabel,
  exportMenu,
  settings,
}: {
  cohortId: string
  cohortLabel: string
  exportMenu?: ReactNode
  settings?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="group-toolbar-actions">
      <GroupImportDialog
        cohortId={cohortId}
        cohortLabel={cohortLabel}
        kindLabels={GROUP_IMPORT_KIND_LABEL}
        outcomeLabels={GROUP_IMPORT_OUTCOME_LABEL}
        maxBytes={GROUP_IMPORT_MAX_BYTES}
      />
      {exportMenu}
      {settings}
    </div>
  )
}
