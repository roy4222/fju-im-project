import { cn } from '@/shared/cn'

/**
 * 收件頁的兩個「平常用不到」的長碼（第三波 W13b；方案 §10、AC-42）：
 * - 檔案核對碼（原本畫面直接印 sha256 前 12 碼）
 * - 繳交證明編號（原本叫「回執編號」，直接印整串請求編號）
 * 一律預設收合，點「顯示」才看全碼。用原生 `<details>`：伺服器頁面與上傳表單（Client Component）都能用、不必載入 JS。
 * 這個檔不 import 任何伺服器模組，學生的上傳表單才能直接用。
 */

function Toggle() {
  return (
    <span className="ml-1 font-medium text-primary-on-subtle underline-offset-2 group-hover:underline">
      <span className="group-open:hidden">顯示</span>
      <span className="hidden group-open:inline">收起</span>
    </span>
  )
}

/** 檔案核對碼：收合時只有字和「顯示」；展開看完整的核對碼（可選取複製）。 */
export function ChecksumDisclosure({ checksum, className }: { checksum: string; className?: string }) {
  return (
    <details className={cn('group text-[11px] text-muted-foreground', className)} data-testid="file-checksum">
      <summary className="inline-flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
        檔案核對碼
        <Toggle />
      </summary>
      <code className="mt-1 block break-all font-mono">{checksum}</code>
    </details>
  )
}

/** 繳交證明編號：旁註「有爭議時才需要」；展開看完整編號。 */
export function ReceiptNoDisclosure({ requestId, className }: { requestId: string; className?: string }) {
  return (
    <details className={cn('group text-xs text-muted-foreground', className)} data-testid="receipt-no">
      <summary className="inline-flex cursor-pointer list-none flex-wrap items-center gap-x-1 [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-foreground">繳交證明編號</span>
        <span>（有爭議時才需要）</span>
        <Toggle />
      </summary>
      <code className="mt-1 block break-all font-mono text-foreground">{requestId}</code>
    </details>
  )
}
