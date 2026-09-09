"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { DASH_VARIANTS, DASH_VARIANT_META, type DashVariant } from "@/lib/data/dash-variant";

/**
 * 後台版本切換列（原型評選用，右下角）。表單 POST 寫 cookie，讓 server component 重新渲染整個後台。
 * `data-prototype-switcher` 讓 scripts/shoot.mjs 截圖時隱藏。定案後移除。
 */
export function VariantSwitcher({ variant }: { variant: DashVariant }) {
  const [open, setOpen] = useState(true);
  const pathname = usePathname();
  const meta = DASH_VARIANT_META[variant];
  return (
    <div data-prototype-switcher className="fixed right-4 bottom-4 z-[100] w-[300px] rounded-xl bg-[#0f1f33] p-3 text-[13px] text-white shadow-2xl">
      <div className="flex items-center justify-between font-bold">
        <span>後台版本評選</span>
        <button type="button" onClick={() => setOpen((v) => !v)} className="rounded border border-white/30 px-2 py-0.5 text-xs" aria-label={open ? "收合" : "展開"}>
          {open ? <IconChevronDown className="size-3.5" /> : <IconChevronUp className="size-3.5" />}
        </button>
      </div>
      {open ? (
        <>
          <form method="post" action="/api/proto-variant" className="mt-2 grid grid-cols-4 gap-1.5">
            <input type="hidden" name="returnTo" value={pathname} />
            {DASH_VARIANTS.map((v) => (
              <button key={v} type="submit" name="variant" value={v} aria-pressed={v === variant} className={`rounded-md border py-1.5 text-[13px] font-semibold transition-colors ${v === variant ? "border-brand bg-brand" : "border-white/15 bg-white/10 hover:bg-white/20"}`}>
                {DASH_VARIANT_META[v].short}
              </button>
            ))}
          </form>
          <p className="mt-2 font-semibold">{meta.label}</p>
          <p className="text-xs leading-relaxed text-white/75">{meta.blurb}</p>
        </>
      ) : null}
    </div>
  );
}
