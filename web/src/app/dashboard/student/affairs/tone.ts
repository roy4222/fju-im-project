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

export const BANNER_CLASS: Readonly<Record<StatusTone, string>> = {
  success: 'bg-primary-subtle text-primary-on-subtle',
  brand: 'bg-primary-subtle text-primary-on-subtle',
  muted: 'bg-muted text-ink',
  info: 'bg-muted text-ink',
  danger: 'bg-danger-subtle text-danger-on-subtle',
}
