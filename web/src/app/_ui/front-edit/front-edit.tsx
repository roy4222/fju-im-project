'use client'
import './front-edit.css'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { FeConfirmDelete, FE_NOT_PROVIDED_MESSAGE } from './confirm'
import { FeDialog } from './dialog'
import { FE_FORMS, FE_KIND_LABEL, notProvided, type FeFields, type FeFormModule, type FeKind } from './forms'

/**
 * 前台編輯層（C2-16；規格② 設計方案 §6.1–§6.4；定案 B）。
 *
 * 只掛在 `/office-edit/*`（`with-front-edit.tsx`），所以 `/`、`/files`… 的模組圖裡沒有它，訪客一個位元組都不多。
 * 平常只有右下角一顆「編輯頁面」；打開後讀頁面上的 `data-fe-*`（`mark.ts` 標的）：
 * - 每個 `[data-fe-section]` 畫虛線框＋左上角標籤（區塊名，有 `data-fe-add` 才有「＋新增」）；
 * - 每則 `[data-fe-item]` 右上角「編輯」，可刪的多「刪除」，不能刪的按鈕 disabled 寫原因，只能改的沒有刪除鈕。
 * 框和按鈕畫在 body 底下自己的一層（portal），**不插進頁面的元素裡**：按鈕永遠在連結外面，
 * 點一則的連結照常跳頁；位置用 CSSOM（`style.setProperty`）設，沒有 inline style 屬性（CSP，§6.4）。
 * 開關存 `sessionStorage`（換頁保持、關分頁就忘）。表單照 `forms.ts` 登錄表按下才載入；
 * 成功後 toast＋`router.refresh()`＋關窗，表單自己不 refresh、不 push、不發 toast（§6.3.1 責任切分）。
 */

const STORAGE_KEY = 'fju-front-edit'

type Box = { top: number; left: number; width: number; height: number }
type SectionMark = { box: Box; label: string; add: FeKind | null; cohort: string | null }
type ItemMark = {
  box: Box
  kind: FeKind
  id: string
  revision: number | null
  fields: FeFields
  title: string
  del: 'yes' | 'no' | null
  reason: string
}
type Panel =
  | { type: 'form'; mode: 'edit' | 'add'; kind: FeKind; id: string | null; revision: number | null; cohortId: string | null; fields: FeFields }
  | { type: 'delete'; kind: FeKind; id: string; revision: number | null; title: string }

function isKind(value: string | undefined): value is FeKind {
  return value !== undefined && Object.hasOwn(FE_FORMS, value)
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect()
  return { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height }
}

function parseFields(raw: string | undefined): FeFields {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as FeFields) : {}
  } catch {
    return {}
  }
}

function scan(): { sections: SectionMark[]; items: ItemMark[] } {
  const sections: SectionMark[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-fe-section]')) {
    const add = el.dataset.feAdd
    sections.push({ box: boxOf(el), label: el.dataset.feSection ?? '', add: isKind(add) ? add : null, cohort: el.dataset.feCohort ?? null })
  }
  const items: ItemMark[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-fe-item]')) {
    const kind = el.dataset.feItem
    const id = el.dataset.feId
    if (!isKind(kind) || !id) continue
    const fields = parseFields(el.dataset.feFields)
    const rev = Number(el.dataset.feRev)
    const del = el.dataset.feDel
    items.push({
      box: boxOf(el),
      kind,
      id,
      revision: el.dataset.feRev !== undefined && Number.isInteger(rev) ? rev : null,
      fields,
      title: String(fields.title ?? fields.name ?? ''),
      del: del === '1' ? 'yes' : del === '0' ? 'no' : null,
      reason: el.dataset.feDelReason ?? '',
    })
  }
  return { sections, items }
}

/** 把一個框放到頁面上的位置（CSSOM，不是 style 屬性）。 */
function place(el: HTMLElement | null, box: Box) {
  if (!el) return
  el.style.setProperty('top', `${box.top}px`)
  el.style.setProperty('left', `${box.left}px`)
  el.style.setProperty('width', `${box.width}px`)
  el.style.setProperty('height', `${box.height}px`)
}

export function FrontEdit() {
  const router = useRouter()
  const [on, setOn] = useState(false)
  const [marks, setMarks] = useState<ReturnType<typeof scan>>({ sections: [], items: [] })
  const [panel, setPanel] = useState<Panel | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const layer = useRef<HTMLDivElement>(null)

  // 開關狀態：換頁保持（sessionStorage）。server render 一律是關的，掛上之後才讀，才不會跟 HTML 對不上。
  useEffect(() => {
    if (window.sessionStorage.getItem(STORAGE_KEY) === '1') setOn(true)
  }, [])

  // 打開時：掃標記、算位置；頁面變了（refresh 換了內容、視窗大小、捲動、圖片載入撐開）就重算。
  useEffect(() => {
    if (!on) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setMarks(scan()))
    }
    update()
    const observer = new MutationObserver((records) => {
      if (records.some((r) => !layer.current?.contains(r.target))) update()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, { capture: true, passive: true })
    document.addEventListener('load', update, { capture: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, { capture: true })
      document.removeEventListener('load', update, { capture: true })
    }
  }, [on])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3000)
    return () => window.clearTimeout(timer)
  }, [toast])

  function toggle() {
    const next = !on
    setOn(next)
    if (next) window.sessionStorage.setItem(STORAGE_KEY, '1')
    else {
      window.sessionStorage.removeItem(STORAGE_KEY)
      setPanel(null)
    }
  }

  function done(message: string) {
    setPanel(null)
    setToast(message)
    router.refresh()
  }

  return (
    <>
      <button type="button" className="fe-toggle" aria-pressed={on} onClick={toggle}>
        {on ? '完成編輯' : '編輯頁面'}
      </button>
      {on
        ? createPortal(
            <div ref={layer} className="fe-layer" data-testid="front-edit-layer">
              {marks.sections.map((s, i) => (
                <div key={`s${i}`} ref={(el) => place(el, s.box)} className="fe-section">
                  <div className="fe-section-label">
                    <span>{s.label}</span>
                    {s.add ? (
                      <button
                        type="button"
                        className="fe-btn fe-btn-sm"
                        aria-label={`新增${FE_KIND_LABEL[s.add]}（${s.label}）`}
                        onClick={() => setPanel({ type: 'form', mode: 'add', kind: s.add!, id: null, revision: null, cohortId: s.cohort, fields: {} })}
                      >
                        ＋新增
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
              {marks.items.map((item, i) => (
                <div key={`i${i}`} ref={(el) => place(el, item.box)} className="fe-item" data-fe-for={item.kind}>
                  <div className="fe-tools">
                    <button
                      type="button"
                      className="fe-btn fe-btn-sm"
                      aria-label={item.title ? `編輯「${item.title}」` : `編輯${FE_KIND_LABEL[item.kind]}`}
                      onClick={() =>
                        setPanel({ type: 'form', mode: 'edit', kind: item.kind, id: item.id, revision: item.revision, cohortId: null, fields: item.fields })
                      }
                    >
                      編輯
                    </button>
                    {item.del === 'yes' ? (
                      <button
                        type="button"
                        className="fe-btn fe-btn-sm fe-btn-danger"
                        aria-label={item.title ? `刪除「${item.title}」` : '刪除'}
                        onClick={() => setPanel({ type: 'delete', kind: item.kind, id: item.id, revision: item.revision, title: item.title })}
                      >
                        刪除
                      </button>
                    ) : item.del === 'no' ? (
                      <button type="button" className="fe-btn fe-btn-sm" disabled title={item.reason}>
                        刪除<small className="fe-reason">{item.reason}</small>
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
      {panel?.type === 'form' ? (
        <FeFormHost
          key={`${panel.mode}:${panel.kind}:${panel.id ?? ''}`}
          panel={panel}
          onCancel={() => setPanel(null)}
          onDone={(result) => done(result?.status === 'published' ? '已發布' : '已儲存')}
        />
      ) : null}
      {panel?.type === 'delete' ? (
        <FeConfirmDelete
          kind={panel.kind}
          id={panel.id}
          revision={panel.revision}
          title={panel.title}
          onCancel={() => setPanel(null)}
          onDeleted={() => done('已刪除')}
        />
      ) : null}
      {toast ? (
        <p role="status" className="fe-toast">
          {toast}
        </p>
      ) : null}
    </>
  )
}

/** 載入那個 kind 的表單模組（按下才載入）並放進視窗；還沒提供的 kind 直接說明。 */
function FeFormHost({
  panel,
  onCancel,
  onDone,
}: {
  panel: Extract<Panel, { type: 'form' }>
  onCancel: () => void
  onDone: (result?: { id: string; status?: 'draft' | 'published' | 'saved' }) => void
}) {
  const loader = FE_FORMS[panel.kind]
  const [state, setState] = useState<{ mod: FeFormModule } | { error: string } | null>(() =>
    loader === notProvided ? { error: FE_NOT_PROVIDED_MESSAGE } : null,
  )

  useEffect(() => {
    if (loader === notProvided) return
    let alive = true
    loader().then(
      (mod) => alive && setState({ mod }),
      () => alive && setState({ error: '表單載入失敗，請重新整理再試。' }),
    )
    return () => {
      alive = false
    }
  }, [loader])

  const Form = state && 'mod' in state ? state.mod.default : null
  return (
    <FeDialog title={`${panel.mode === 'add' ? '新增' : '編輯'}${FE_KIND_LABEL[panel.kind]}`} onClose={onCancel}>
      {Form ? (
        <Form
          mode={panel.mode}
          kind={panel.kind}
          id={panel.id}
          revision={panel.revision}
          cohortId={panel.cohortId}
          fields={panel.fields}
          onDone={onDone}
          onCancel={onCancel}
        />
      ) : state && 'error' in state ? (
        <>
          <p role="alert" className="fe-error">
            {state.error}
          </p>
          <div className="fe-actions">
            <button type="button" className="fe-btn" onClick={onCancel}>
              關閉
            </button>
          </div>
        </>
      ) : (
        <p className="fe-loading">載入中…</p>
      )}
    </FeDialog>
  )
}
