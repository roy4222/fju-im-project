'use client'
import type { FeFormProps } from '@/app/_ui/front-edit/forms'
import { ItemAdapter, removeItem } from '@/app/dashboard/admin/affairs/front-edit/item-adapter'

/** 前台直接編輯「作業」：共用 adapter 綁 `placement='submission'`（C 階段規格① §11.3）。 */
export default function SubmissionFrontEditForm(props: FeFormProps) {
  return <ItemAdapter {...props} placement="submission" />
}

export const remove = removeItem
