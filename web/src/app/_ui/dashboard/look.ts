import { buttonVariants } from '@/app/_ui/ui/button'

/**
 * 後台表單與對話框的共用樣式字串（原型 `stamp.tsx` 的 INPUT／TEXTAREA、原型 Dialog 的外觀）。
 *
 * 正式碼的對話框是原生 `<dialog>`（`showModal()` 自帶焦點鎖與 Esc），行為不換；
 * 這裡只讓它**看起來**跟原型的 base-ui Dialog 一樣：圓角 xl、細環線、淡灰遮罩、內距 16px。
 */

const DIALOG_BASE =
  'm-auto max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border-0 bg-popover p-0 text-sm text-popover-foreground ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs'

export const DIALOG = {
  sm: `${DIALOG_BASE} w-[min(24rem,calc(100vw-2rem))]`,
  md: `${DIALOG_BASE} w-[min(28rem,calc(100vw-2rem))]`,
  lg: `${DIALOG_BASE} w-[min(32rem,calc(100vw-2rem))]`,
  xl: `${DIALOG_BASE} w-[min(40rem,calc(100vw-2rem))]`,
  '2xl': `${DIALOG_BASE} w-[min(42rem,calc(100vw-2rem))]`,
} as const

/** 對話框內距與區塊間距（原型 DialogContent：p-4、gap-4）。 */
export const DIALOG_BODY = 'flex flex-col gap-4 p-4 sm:p-5'
export const DIALOG_TITLE = 'text-lg font-extrabold text-foreground'
export const DIALOG_DESC = 'mt-1 text-sm text-muted-foreground'

/** 對話框底部的主要動作（原型 `btn-fju h-11`，整排）。 */
export const BTN_SUBMIT = 'btn-fju h-11 px-5 text-sm disabled:pointer-events-none disabled:opacity-60'
/** 頁面右上的主要動作（原型「新增合作案」「新增簽核」）。 */
export const BTN_PAGE = 'btn-fju h-10 px-4 text-sm'
/** 次要動作：白底細框。 */
export const BTN_OUTLINE = buttonVariants({ variant: 'outline', size: 'lg', className: 'press rounded-lg' })
/** 對話框裡的「取消」「關閉」：白底細框、跟主要動作等高。 */
export const BTN_OUTLINE_TALL = buttonVariants({ variant: 'outline', size: 'lg', className: 'press h-11 rounded-lg px-4' })
/** 表格列上的小按鈕。 */
export const BTN_ROW = buttonVariants({ variant: 'outline', size: 'sm', className: 'press rounded-lg' })
export const BTN_ROW_GHOST = buttonVariants({ variant: 'ghost', size: 'sm', className: 'press rounded-lg' })
export const BTN_ROW_PRIMARY = buttonVariants({ size: 'sm', className: 'press rounded-lg' })
/** 危險動作（停用、作廢）：原型用 shadcn destructive 變體。 */
export const BTN_DANGER = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press h-11 rounded-lg px-4' })

export const INPUT =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 aria-invalid:border-destructive disabled:opacity-60'
export const TEXTAREA =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 aria-invalid:border-destructive disabled:opacity-60'
export const SELECT = INPUT
export const LABEL = 'flex flex-col gap-1.5 text-sm font-semibold text-foreground'
/** 欄位旁的補充說明（「・必填，會寫入紀錄」）。 */
export const LABEL_HINT = 'font-normal text-muted-foreground'

/** 被拒絕／出錯的訊息（原型：紅字粗體一行）。 */
export const ALERT = 'rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle'
/** 成功或提示訊息。 */
export const NOTE = 'rounded-lg bg-brand-subtle px-3 py-2 text-sm text-brand-on-subtle'
/** 對話框裡的「目前資料」摘要（原型淡灰底 dl）。 */
export const INFO_DL = 'grid grid-cols-[5rem_1fr] gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-sm'
