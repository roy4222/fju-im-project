'use client'
import type { FeFormProps } from '@/app/_ui/front-edit/forms'
import { ItemAdapter, removeItem } from '@/app/dashboard/admin/affairs/front-edit/item-adapter'

/** 前台直接編輯「公告（含競賽資訊）」：共用 adapter 綁 `placement='news'`（C 階段規格① §11.3）。 */
export default function NewsFrontEditForm(props: FeFormProps) {
  return <ItemAdapter {...props} placement="news" />
}

export const remove = removeItem
