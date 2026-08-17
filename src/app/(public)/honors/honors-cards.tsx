"use client";

import { useState } from "react";
import { IconTrophy } from "@tabler/icons-react";
import { ImagePlaceholder } from "@/components/public/sections";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { HONORS, type HonorItem } from "@/lib/fixtures";

/**
 * 榮譽榜卡片。
 *
 * 0715 會議紀錄 §9：「卡片一格一格，點開是一張圖片 + 文字」，並特別提醒
 * 「封面圖尺寸需注意，避免大頭照被切一半；考慮以放大處理而非切成兩格」。
 * 因此得獎照片一律以完整顯示為原則（object-contain + 留白），不用 cover 裁切。
 */
export function HonorsCards() {
  const [open, setOpen] = useState<HonorItem | null>(null);

  return (
    <>
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {HONORS.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => setOpen(h)}
              className="press group flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-brand/45"
            >
              {/* 得獎照片：完整顯示不裁切，因此用 contain 的留白框 */}
              <ImagePlaceholder
                className="aspect-[16/10]"
                note="得獎照片待提供（完整顯示，不裁切）"
              />
              <div className="flex flex-1 flex-col p-4">
                <div className="flex items-center gap-2">
                  <IconTrophy className="size-4 shrink-0 text-brand" aria-hidden />
                  <Badge
                    variant="outline"
                    className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
                  >
                    {h.award}
                  </Badge>
                  <time className="tabular ml-auto text-xs text-muted-foreground">{h.year}</time>
                </div>
                <p className="type-card-title mt-2.5 group-hover:text-primary">{h.competition}</p>
                <p className="mt-1.5 text-sm text-muted-foreground">{h.team}</p>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <Dialog open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-w-2xl">
          {open ? (
            <>
              <ImagePlaceholder
                className="aspect-[16/9] rounded-lg border border-border"
                note="得獎照片待提供"
              />
              <div className="mt-4 flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
                >
                  {open.award}
                </Badge>
                <time className="tabular text-xs text-muted-foreground">{open.year}</time>
              </div>
              <DialogTitle className="type-card-title mt-2 text-lg">
                {open.competition}
              </DialogTitle>
              <DialogDescription className="mt-2 text-[0.9375rem] leading-relaxed">
                由 {open.team} 於 {open.year} 年獲得 {open.award}
                。完整得獎名單、作品說明與活動相簿由系辦於系統中維護。
              </DialogDescription>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
