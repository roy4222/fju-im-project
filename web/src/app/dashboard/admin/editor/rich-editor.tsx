'use client'
import dynamic from 'next/dynamic'
import { useState } from 'react'
import { INPUT, SECONDARY } from '@/app/dashboard/admin/affairs/item-form-parts'
import { cn } from '@/shared/cn'

/**
 * 正文欄（AD-B5，設計方案 §8.2）：預設所見即所得（Tiptap，動態載入、不進 First Load JS），
 * 可切「原始 HTML」直接改 textarea。兩邊讀寫同一個 `body` 字串；切過去時另一邊用目前的字串重建。
 *
 * 兩種模式的輸入區都叫 `#ed-body`、都以「正文」標題為名稱，同一時間只有一個在畫面上。
 */

const TiptapEditor = dynamic(() => import('./tiptap-editor').then((m) => m.TiptapEditor), {
  ssr: false,
  loading: () => <p className="min-h-56 px-4 py-3 text-sm text-muted-foreground">編輯器載入中…</p>,
})

type Mode = 'rich' | 'html'

const LABEL_ID = 'ed-body-label'
const LINK_INPUT = cn(INPUT, 'mt-0 h-8 min-h-8 min-w-0 flex-1 py-1')
const LINK_BUTTON = cn(SECONDARY, 'h-8')

export function RichEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (body: string) => void
  placeholder: string
}) {
  const [mode, setMode] = useState<Mode>('rich')
  const modeButton = (m: Mode, text: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => setMode(m)}
      className={cn(
        'rounded px-2 py-0.5 text-xs font-semibold text-muted-foreground hover:text-foreground',
        mode === m && 'bg-background text-foreground shadow-sm',
      )}
    >
      {text}
    </button>
  )

  return (
    <div className="min-w-0 rounded-lg border border-input focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/25">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span id={LABEL_ID} className="text-xs font-semibold">
          正文（網頁排版格式，可直接打字）
        </span>
        <div role="group" aria-label="正文編輯方式" className="ml-auto flex gap-0.5 rounded-md bg-muted p-0.5">
          {modeButton('rich', '所見即所得')}
          {modeButton('html', '原始 HTML')}
        </div>
      </div>
      {mode === 'rich' ? (
        <TiptapEditor value={value} onChange={onChange} labelledBy={LABEL_ID} placeholder={placeholder} inputClass={LINK_INPUT} buttonClass={LINK_BUTTON} />
      ) : (
        <textarea
          id="ed-body"
          aria-labelledby={LABEL_ID}
          rows={10}
          spellCheck={false}
          className="w-full resize-y bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </div>
  )
}
