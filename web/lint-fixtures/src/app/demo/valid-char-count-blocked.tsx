'use client'
// 合法例（CL-7）：不受控欄位送出前用 blockOverLimit 擋；受控欄位把 value 傳給 CharCount。
import { useState } from 'react'
import { blockOverLimit, CharCount } from '@/app/_ui/char-count'

export function DemoReason({ act }: { act: (data: FormData) => void }) {
  const [message, setMessage] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  return (
    <div>
      <form action={act} onSubmit={(e) => setMessage(blockOverLimit(e, 'reason', 200, '最多 200 字'))}>
        <textarea id="reason" name="reason" />
        <CharCount forId="reason" max={200} />
        {message}
      </form>
      <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <CharCount forId="title" max={50} value={title} />
    </div>
  )
}
