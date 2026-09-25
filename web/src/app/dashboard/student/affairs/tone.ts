import type { StatusTone } from '@/application/submissions'

/**
 * 狀態字的顏色（只用系網橘一個主軸色：已繳用橘色深字、待繳用橘色、逾期用紅、其他灰）。
 * 作業區列表與內容頁的橫幅共用。
 */
export const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  success: 'text-primary-on-subtle',
  brand: 'text-primary',
  muted: 'text-muted-foreground',
  info: 'text-ink',
  danger: 'text-danger-on-subtle',
}

/**
 * 學生作業區與內容頁的狀態色（票 38：照原型 `student-status.ts` 的 TONE_CLS 與內容頁橫幅）：
 * 已繳用綠、待繳用橘、逾期用紅、其他灰。老師與系辦頁仍用上面的 `TONE_CLASS`（各自的票再對原型）。
 */
export const STUDENT_TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  success: 'text-success-on-subtle',
  brand: 'text-brand-on-subtle',
  muted: 'text-muted-foreground',
  info: 'text-info-on-subtle',
  danger: 'text-destructive',
}

export const BANNER_CLASS: Readonly<Record<StatusTone, string>> = {
  success: 'bg-success-subtle text-success-on-subtle',
  brand: 'bg-brand-subtle text-brand-on-subtle',
  muted: 'bg-muted text-ink',
  info: 'bg-info-subtle text-info-on-subtle',
  danger: 'bg-destructive-subtle text-destructive-on-subtle',
}
