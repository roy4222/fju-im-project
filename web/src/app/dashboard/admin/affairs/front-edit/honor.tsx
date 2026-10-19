'use client'
import type { FeFormProps } from '@/app/_ui/front-edit/forms'
import { ItemAdapter, removeItem } from '@/app/dashboard/admin/affairs/front-edit/item-adapter'

/** 前台直接編輯「榮譽榜」：共用 adapter 綁 `placement='honor'`（C 階段規格① §11.3）。 */
export default function HonorFrontEditForm(props: FeFormProps) {
  return <ItemAdapter {...props} placement="honor" />
}

export const remove = removeItem
