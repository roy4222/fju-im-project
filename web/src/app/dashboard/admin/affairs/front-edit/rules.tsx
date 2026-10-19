'use client'
import type { FeFormProps } from '@/app/_ui/front-edit/forms'
import { ItemAdapter, removeItem } from '@/app/dashboard/admin/affairs/front-edit/item-adapter'

/** 前台直接編輯「專題規則章節」：共用 adapter 綁 `placement='rules'`（C 階段規格① §11.3）。 */
export default function RulesFrontEditForm(props: FeFormProps) {
  return <ItemAdapter {...props} placement="rules" />
}

export const remove = removeItem
