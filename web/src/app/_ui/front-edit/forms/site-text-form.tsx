'use client'
import { useState, useTransition, type FormEvent } from 'react'
import type { FeFormProps } from '../forms'
import { feActions } from './registry'

/**
 * 站內文字的前台編輯表單（C2-17；規格② 設計方案 §6.5）：同一個模組登錄給三種 kind。
 * - `footer_contact`：頁尾聯絡資料八欄（系網兩欄可留空）。
 * - `quick_card`：三張快速入口卡的標題與說明（`id` 是 `quick_card_1..3`；中間那張只有這兩欄，連結照登入狀態）。
 * - `privacy`：隱私權政策整篇內文（`# 標題` 起一節、空行分段；「聯絡我們」由程式接頁尾）。
 *
 * 預填來自 `data-fe-fields`，版本來自 `data-fe-rev`；表單自己不重整、不跳 toast，成功只呼叫 `onDone`（框架關窗＋重整）。
 * 必填與字數上限由用例判，拒絕時這裡把那一句顯示在欄位上方，打到一半的內容還在。樣式只用 class（CSP 沒有 unsafe-inline）。
 */

/** 頁尾聯絡資料的欄位與標籤（跟 `application/site` 的 `FOOTER_CONTACT_LABEL` 同一套字；用例的錯誤訊息用它）。 */
const FOOTER_FIELDS: readonly { name: string; label: string; hint?: string }[] = [
  { name: 'department', label: '系所名稱' },
  { name: 'address', label: '地址' },
  { name: 'phone', label: '電話', hint: '例如 02-2905-2666；連結會自動轉成可撥號的格式。' },
  { name: 'siteLabel', label: '系網（顯示文字）', hint: '留空就不顯示系網那一行。' },
  { name: 'siteHref', label: '系網網址', hint: '以 https:// 開頭。' },
  { name: 'slogan', label: '一句話介紹' },
  { name: 'officeNote', label: '專題洽詢說明' },
  { name: 'industryNote', label: '產學洽詢說明' },
]

/**
 * 樣式字串跟 `_ui/dashboard/look.ts` 的 INPUT／TEXTAREA／LABEL／BTN_SUBMIT 同字，刻意不 import：
 * 這個模組是按下「編輯」才載的延遲 chunk，一 import 共用模組 Turbopack 就把每頁都載的共用 chunk 再切一塊、gzip 變差（AC-C2-44 步驟 7：`/` 不能變大）。
 */
const INPUT =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 aria-invalid:border-destructive disabled:opacity-60'
const LABEL = 'flex flex-col gap-1.5 text-sm font-semibold text-foreground'
const BTN_SUBMIT = 'btn-fju h-11 px-5 text-sm disabled:pointer-events-none disabled:opacity-60'
const TEXTAREA =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 aria-invalid:border-destructive disabled:opacity-60'
const HINT = '-mt-2 text-xs text-muted-foreground'

const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value))

export default function SiteTextForm({ kind, id, revision, fields, onDone, onCancel }: FeFormProps) {
  const key = id ?? kind
  const names =
    kind === 'footer_contact' ? FOOTER_FIELDS.map((f) => f.name) : kind === 'privacy' ? ['body'] : ['title', 'description']
  // 受控：送出被拒（例如另一個分頁先存過）時，打到一半的內容還在。
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(names.map((n) => [n, str(fields[n])])))
  const [requestId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const set = (name: string) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [name]: e.target.value }))
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await feActions().saveSiteText({ key, revision: revision ?? 0, requestId, fields: values })
      if (result.ok) onDone({ id: key, status: 'saved' })
      else setError(result)
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label={`編輯${str(fields.title) || key}`} data-testid="fe-site-text-form">
      {error ? (
        <p role="alert" className="fe-error">
          {error.message}
        </p>
      ) : null}
      {kind === 'footer_contact'
        ? FOOTER_FIELDS.map((f) => (
            // 提示放在 label 外（aria-describedby），label 的名稱只有欄位名。
            <div key={f.name} className="flex flex-col gap-1">
              <label className={LABEL}>
                {f.label}
                <input
                  name={f.name}
                  value={values[f.name] ?? ''}
                  onChange={set(f.name)}
                  className={INPUT}
                  disabled={pending}
                  aria-invalid={error?.field === f.name || undefined}
                  aria-describedby={f.hint ? `fe-hint-${f.name}` : undefined}
                />
              </label>
              {f.hint ? (
                <p id={`fe-hint-${f.name}`} className={HINT}>
                  {f.hint}
                </p>
              ) : null}
            </div>
          ))
        : null}
      {kind === 'quick_card' ? (
        <>
          <label className={LABEL}>
            標題
            <input name="title" value={values.title ?? ''} onChange={set('title')} className={INPUT} disabled={pending} aria-invalid={error?.field === 'title' || undefined} />
          </label>
          <label className={LABEL}>
            說明
            <textarea
              name="description"
              value={values.description ?? ''}
              onChange={set('description')}
              className={TEXTAREA}
              rows={3}
              disabled={pending}
              aria-invalid={error?.field === 'description' || undefined}
              aria-describedby="fe-hint-description"
            />
          </label>
          <p id="fe-hint-description" className={HINT}>
            顯示在連結下面；留空就不顯示。連結與按鈕照登入狀態，不在這裡改。
          </p>
        </>
      ) : null}
      {kind === 'privacy' ? (
        <>
          <label className={LABEL}>
            內文
            <textarea
              name="body"
              value={values.body ?? ''}
              onChange={set('body')}
              className={`${TEXTAREA} min-h-80 font-mono text-[13px]`}
              rows={18}
              disabled={pending}
              aria-invalid={error?.field === 'body' || undefined}
              aria-describedby="fe-hint-body"
            />
          </label>
          <p id="fe-hint-body" className={HINT}>
            以「# 標題」起一節，空一行分段。「聯絡我們」那一節由頁尾聯絡資料自動帶入，不用寫。
          </p>
        </>
      ) : null}
      <div className="fe-actions">
        <button type="button" className="fe-btn" onClick={onCancel} disabled={pending}>
          取消
        </button>
        <button type="submit" className={BTN_SUBMIT} disabled={pending}>
          {pending ? '儲存中…' : '儲存'}
        </button>
      </div>
    </form>
  )
}
