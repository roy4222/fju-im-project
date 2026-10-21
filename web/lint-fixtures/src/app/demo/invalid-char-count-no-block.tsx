'use client'
// 反例（CL-7）：不受控欄位拿掉 maxLength、只顯示字數，送出前沒擋——伺服器拒絕時 React 重設表單、字被清空。
import { CharCount } from '@/app/_ui/char-count'

export function DemoReason({ act }: { act: (data: FormData) => void }) {
  return (
    <form action={act}>
      <textarea id="reason" name="reason" />
      <CharCount forId="reason" max={200} />
    </form>
  )
}
