import type { ShowcaseAward } from '@/application/showcase/ports'
import { err, type Err } from '@/shared/result'

/**
 * 優秀專題的生命週期規則（第三波 W2；設計方案 §4、Q12、Q31）。純規則，用例與畫面共用同一份。
 *
 * - 發布：草稿 → 公開中（系辦勾「已取得這組同學同意公開」）。
 * - 下架：公開中 → 已下架（前台看不到、後台還在，可以重新發布）。
 * - 重新發布：已下架 → 公開中（不切新版本，用下架前那一版）。
 * - 刪除：只限草稿與已下架（公開中要先下架）；後台與前台都消失、不能恢復（§2）。
 * - 獎項：任何狀態都能設（不改內容）；有等級才會上「優秀專題」與首頁輪播。
 * - 發布更新（W15）：公開中 → 公開中，把改好的草稿凍結成新版本換上前台；下架中的要先重新發布。
 * - 首頁順序（W15）：任何狀態都能設；只決定輪播裡的先後（1 最前、沒填排後面）。
 */

export type ShowcaseStatus = 'draft' | 'published' | 'withdrawn'
export type ShowcaseLifecycleAction = 'publish' | 'publish_update' | 'withdraw' | 'republish' | 'delete'

export const SHOWCASE_STATUS_LABEL: Readonly<Record<ShowcaseStatus, string>> = {
  draft: '草稿',
  published: '公開中',
  withdrawn: '已下架',
}

const FROM: Readonly<Record<ShowcaseLifecycleAction, readonly ShowcaseStatus[]>> = {
  publish: ['draft'],
  publish_update: ['published'],
  withdraw: ['published'],
  republish: ['withdrawn'],
  delete: ['draft', 'withdrawn'],
}

const BLOCKED: Readonly<Record<ShowcaseLifecycleAction, (status: ShowcaseStatus) => string>> = {
  publish: (s) => (s === 'withdrawn' ? '這件作品已下架；要讓它回到前台請按「重新發布」。' : '這件作品已經公開中，不用再發布。'),
  publish_update: (s) =>
    s === 'draft' ? '這件作品還沒發布過；請勾同意後按「發布」。' : '這件作品已下架；請先按「重新發布」，再發布更新。',
  withdraw: (s) => (s === 'draft' ? '這件作品還是草稿，沒有公開，不用下架。' : '這件作品已經下架了。'),
  republish: (s) => (s === 'draft' ? '這件作品還沒發布過；請勾同意後按「發布」。' : '這件作品已經公開中。'),
  delete: () => '公開中的作品不能直接刪除；請先按「下架」，確認前台看不到後再刪除。',
}

/** 這個動作在這個狀態能不能做；不能時回一句說明原因與下一步的話，能做回 null。 */
export function checkShowcaseLifecycle(action: ShowcaseLifecycleAction, status: ShowcaseStatus): string | null {
  return FROM[action].includes(status) ? null : BLOCKED[action](status)
}

export const AWARD_LABEL_MAX = 100

export const AWARD_LEVEL_LABEL: Readonly<Record<ShowcaseAward, string>> = {
  excellent: '優秀專題',
  merit: '佳作',
}

/** 表單送來的獎項 → 可以存的樣子（DB 約束 `showcase_entries_award_*_check` 同一組規則，這裡先說得出原因）。 */
export function normalizeAward(input: {
  readonly level: unknown
  readonly label: unknown
}): { ok: true; value: { level: ShowcaseAward | null; label: string | null } } | Err {
  const rawLevel = String(input.level ?? '').trim()
  const label = String(input.label ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
  if (rawLevel === '') {
    if (label !== '') return err('VALIDATION_FAILED', '要填獎項名稱，請先選獎項等級。', { details: { field: 'awardLabel' } })
    return { ok: true, value: { level: null, label: null } }
  }
  if (rawLevel !== 'excellent' && rawLevel !== 'merit') {
    return err('VALIDATION_FAILED', '獎項等級只能是「優秀專題」或「佳作」。', { details: { field: 'awardLevel' } })
  }
  if (label.length > AWARD_LABEL_MAX) {
    return err('VALIDATION_FAILED', `獎項名稱最多 ${AWARD_LABEL_MAX} 個字。`, { details: { field: 'awardLabel' } })
  }
  return { ok: true, value: { level: rawLevel, label: label === '' ? null : label } }
}

export const HOME_POSITION_MAX = 99

/** 首頁順序：空白＝不排（null）；否則 1–99 的整數（DB 約束 `showcase_entries_home_position_check` 同一組規則）。 */
export function normalizeHomePosition(raw: unknown): { ok: true; value: number | null } | Err {
  const text = String(raw ?? '').trim()
  if (text === '') return { ok: true, value: null }
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1 || value > HOME_POSITION_MAX) {
    return err('VALIDATION_FAILED', `首頁順序要填 1 到 ${HOME_POSITION_MAX} 的整數（1 排最前）；不想排就留空。`, {
      details: { field: 'homePosition' },
    })
  }
  return { ok: true, value }
}
