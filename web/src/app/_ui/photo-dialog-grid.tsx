'use client'
import Link from 'next/link'
import { useState } from 'react'
import { IconArrowRight, IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { ToneTag, type TagTone } from '@/app/_ui/public-blocks'
import { Dialog, DialogContent, DialogTitle } from '@/app/_ui/ui/dialog'
import { cn } from '@/shared/cn'

export type PhotoEntry = {
  readonly id: string
  /** 已經算好的圖片網址（`/api/files/<id>` 或佔位圖）。 */
  readonly image: string
  readonly title: string
  readonly date?: string
  readonly tags: readonly { readonly label: string; readonly tone?: TagTone }[]
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly summary: string
  readonly moreHref?: string
  readonly moreLabel?: string
}

/**
 * 「一圖一文」卡片格（原型 `components/public/photo-dialog-grid.tsx`；0715 §9 榮譽榜／優秀專題「點開是一張圖片＋文字」）。
 * 卡片點開 dialog，圖用 contain 不裁切（人物照不裁）；dialog 內可上一件／下一件。`initialOpenId` 給 `?item=` 深連結。
 *
 * 圖片用一般 `<img>`：`next/image` 會輸出 style 屬性，被正式站 CSP 擋。
 */
export function PhotoDialogGrid({
  entries,
  columns = 4,
  initialOpenId,
}: {
  entries: readonly PhotoEntry[]
  columns?: 3 | 4
  initialOpenId?: string
}) {
  const [index, setIndex] = useState<number | null>(() => {
    const i = initialOpenId ? entries.findIndex((e) => e.id === initialOpenId) : -1
    return i >= 0 ? i : null
  })
  const current = index === null ? null : entries[index]
  const step = (d: number) => setIndex((i) => (i === null ? null : (i + d + entries.length) % entries.length))

  return (
    <>
      <ul className={cn('grid gap-6 sm:grid-cols-2', columns === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
        {entries.map((e, i) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => setIndex(i)}
              data-testid="photo-card"
              className="group card-lift flex h-full w-full flex-col overflow-hidden rounded-xl bg-secondary text-left shadow-[0_2px_10px_rgba(0,51,102,0.08)]"
              aria-haspopup="dialog"
            >
              <div className="relative aspect-video overflow-hidden bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={e.image}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                />
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4.5">
                {e.date ? <span className="tabular text-[13px] font-semibold text-muted-foreground">{e.date}</span> : null}
                <span className="type-card-title text-foreground group-hover:text-primary">{e.title}</span>
                <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                  {e.tags.map((t) => (
                    <ToneTag key={t.label} tone={t.tone ?? 'brand'}>
                      {t.label}
                    </ToneTag>
                  ))}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <Dialog open={current !== null} onOpenChange={(o) => !o && setIndex(null)}>
        <DialogContent
          className="grid max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] grid-cols-1 gap-0 overflow-y-auto p-0 sm:max-w-[960px] md:grid-cols-[1.2fr_1fr]"
          showCloseButton
        >
          {current ? (
            <>
              <div className="relative min-h-[260px] bg-[#0b1a2b] md:min-h-[440px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={current.image} alt={current.title} className="absolute inset-0 h-full w-full object-contain" />
              </div>
              <div className="flex flex-col gap-3.5 p-7">
                <div className="flex flex-wrap gap-1.5">
                  {current.tags.map((t) => (
                    <ToneTag key={t.label} tone={t.tone ?? 'brand'}>
                      {t.label}
                    </ToneTag>
                  ))}
                </div>
                <DialogTitle className="pr-8 text-2xl leading-snug font-extrabold text-foreground">{current.title}</DialogTitle>
                {current.summary ? <p className="text-[15px] leading-relaxed text-muted-foreground">{current.summary}</p> : null}
                <dl className="flex flex-col gap-1 text-sm">
                  {current.facts.map((f) => (
                    <div key={f.label} className="flex gap-2">
                      <dt className="shrink-0 text-muted-foreground">{f.label}：</dt>
                      <dd className="text-foreground">{f.value}</dd>
                    </div>
                  ))}
                </dl>
                {current.moreHref ? (
                  <Link href={current.moreHref} className="btn-fju mt-auto h-10 self-start px-4 text-sm">
                    {current.moreLabel ?? '查看完整資料'} <IconArrowRight className="size-4" />
                  </Link>
                ) : null}
                <div className="flex items-center justify-between border-t border-border pt-3 text-[13px] text-muted-foreground">
                  <button type="button" onClick={() => step(-1)} className="inline-flex items-center gap-1 hover:text-foreground" aria-label="上一件">
                    <IconChevronLeft className="size-4" /> 上一件
                  </button>
                  <span className="tabular">
                    {(index ?? 0) + 1} / {entries.length}
                  </span>
                  <button type="button" onClick={() => step(1)} className="inline-flex items-center gap-1 hover:text-foreground" aria-label="下一件">
                    下一件 <IconChevronRight className="size-4" />
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
