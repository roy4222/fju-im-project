"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { IconArrowRight, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AwardBadge, Tag } from "@/components/public/blocks";
import type { ProjectAward } from "@/lib/fixtures";

export type PhotoEntry = {
  id: string;
  image: string;
  title: string;
  date?: string;
  tags: { label: string; tone?: "brand" | "navy" }[];
  award?: ProjectAward;
  awardLabel?: string;
  facts: { label: string; value: string }[];
  summary: string;
  moreHref?: string;
  moreLabel?: string;
};

/**
 * 「一圖一文」卡片格：7/15 §9 榮譽榜／優秀專題「點開是一張圖片＋文字」。
 * 卡片點開 dialog，海報用 contain 不裁切；dialog 內可上一件／下一件。
 */
export function PhotoDialogGrid({ entries, columns = 4, initialOpenId }: { entries: PhotoEntry[]; columns?: 3 | 4; initialOpenId?: string }) {
  // `?item=` 深連結：讓榮譽與優秀專題有可分享的網址（規格 §14.4）
  const [index, setIndex] = useState<number | null>(() => {
    const i = initialOpenId ? entries.findIndex((e) => e.id === initialOpenId) : -1;
    return i >= 0 ? i : null;
  });
  const current = index === null ? null : entries[index];
  const step = (d: number) => setIndex((i) => (i === null ? null : (i + d + entries.length) % entries.length));

  return (
    <>
      <ul className={`grid gap-6 sm:grid-cols-2 ${columns === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        {entries.map((e, i) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => setIndex(i)}
              className="group flex h-full w-full flex-col overflow-hidden rounded-xl bg-secondary text-left shadow-[0_2px_10px_rgba(0,51,102,0.08)] transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-[0_8px_22px_rgba(0,51,102,0.14)]"
              aria-haspopup="dialog"
            >
              <div className="relative aspect-video overflow-hidden bg-muted">
                <Image src={e.image} alt="" fill sizes="(max-width: 640px) 100vw, 300px" className="object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                <AwardBadge award={e.award} label={e.awardLabel} className="absolute top-3 left-3 shadow-md" />
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4.5">
                {e.date ? <span className="tabular text-[13px] font-semibold text-muted-foreground">{e.date}</span> : null}
                <span className="type-card-title text-foreground group-hover:text-brand">{e.title}</span>
                <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                  {e.tags.map((t) => (
                    <Tag key={t.label} tone={t.tone ?? "brand"}>{t.label}</Tag>
                  ))}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <Dialog open={current !== null} onOpenChange={(o) => !o && setIndex(null)}>
        <DialogContent className="grid max-w-[calc(100%-2rem)] grid-cols-1 gap-0 overflow-hidden p-0 sm:max-w-[960px] md:grid-cols-[1.2fr_1fr]" showCloseButton>
          {current ? (
            <>
              <div className="relative min-h-[260px] bg-[#0b1a2b] md:min-h-[440px]">
                <Image src={current.image} alt={current.title} fill sizes="(max-width: 768px) 100vw, 560px" className="object-contain" />
              </div>
              <div className="flex flex-col gap-3.5 p-7">
                <div className="flex flex-wrap gap-1.5">
                  <AwardBadge award={current.award} label={current.awardLabel} />
                  {current.tags.map((t) => (
                    <Tag key={t.label} tone={t.tone ?? "brand"}>{t.label}</Tag>
                  ))}
                </div>
                <DialogTitle className="pr-8 text-2xl font-extrabold leading-snug">{current.title}</DialogTitle>
                <p className="text-[15px] leading-relaxed text-muted-foreground">{current.summary}</p>
                <dl className="flex flex-col gap-1 text-sm">
                  {current.facts.map((f) => (
                    <div key={f.label} className="flex gap-2">
                      <dt className="shrink-0 text-muted-foreground">{f.label}：</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
                {current.moreHref ? (
                  <Link href={current.moreHref} className="btn-fju mt-auto h-10 self-start px-4 text-sm">
                    {current.moreLabel ?? "查看完整資料"} <IconArrowRight className="size-4" />
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
  );
}
