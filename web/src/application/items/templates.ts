import type { FormField, ReceiverUnit } from '@/application/items/items'

/**
 * 收件範本（第三波 W12；設計方案 §6 Q9）：完整編輯器按一下就插入一組固定欄位。
 *
 * 範本只用既有欄位型別（短文字／長文字），存下去跟手動加的欄位一樣，不開新的發布位置。
 * 欄位代號固定（不是瀏覽器亂數），日後匯入助教 Google 表單的資料時可以照代號對欄；
 * 同一個項目重複套用時，代號已經在的欄位不會再插一次。
 */
export type ItemTemplate = {
  readonly id: string
  /** 按鈕上的字。 */
  readonly label: string
  /** 按鈕旁的一句說明。 */
  readonly description: string
  /** 套用後的收件單位。 */
  readonly receiverUnit: Exclude<ReceiverUnit, 'none'>
  readonly fields: readonly FormField[]
}

/** 專題需求表：欄位同助教的 Google 表單（Q9）。 */
export const PROJECT_REQUIREMENT_TEMPLATE: ItemTemplate = {
  id: 'project_requirement',
  label: '套用專題需求表欄位',
  description: '插入指導老師、組長、專題名稱、開發軟體、硬體需求等 7 個欄位，繳交方式改為整組一份',
  receiverUnit: 'group',
  fields: [
    { key: 'advisor', type: 'text', label: '指導老師', required: true },
    { key: 'leader', type: 'text', label: '組長', required: true },
    { key: 'title_en', type: 'text', label: '專題名稱（英文）', required: true },
    { key: 'title_zh', type: 'text', label: '專題名稱（中文）', required: false, help: '還沒有中文名稱可以先留空' },
    { key: 'software', type: 'textarea', label: '開發軟體', required: true, help: '例：VS Code、Android Studio、Unity' },
    { key: 'hardware', type: 'textarea', label: '硬體需求', required: true, help: '不需要特殊硬體請寫「無」' },
    { key: 'hardware_other', type: 'textarea', label: '其他硬體', required: false },
  ],
}

export const ITEM_TEMPLATES: readonly ItemTemplate[] = [PROJECT_REQUIREMENT_TEMPLATE]

