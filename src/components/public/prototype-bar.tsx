"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { ROLE_LABEL, type ViewerRole } from "@/lib/data/roles";

const ROLES: ViewerRole[] = ["guest", "student", "teacher", "admin"];

/**
 * 原型操作列：右下角切換身分。正式版接 Auth 後移除。
 * 用表單 POST 到 /api/proto-role 寫 cookie，讓 server component 重新渲染。
 */
export function PrototypeBar({ role }: { role: ViewerRole }) {
  const [open, setOpen] = useState(true);
  const pathname = usePathname();
  return (
    <div className="fixed right-4 bottom-4 z-[100] w-[280px] rounded-xl bg-[#0f1f33] p-3 text-[13px] text-white shadow-2xl">
      <div className="flex items-center justify-between font-bold">
        <span>原型操作列</span>
        <button type="button" onClick={() => setOpen((v) => !v)} className="rounded border border-white/30 px-2 py-0.5 text-xs" aria-label={open ? "收合" : "展開"}>
          {open ? <IconChevronDown className="size-3.5" /> : <IconChevronUp className="size-3.5" />}
        </button>
      </div>
      {open ? (
        <>
          <p className="mt-2 opacity-80">切換身分（模擬登入）</p>
          <form method="post" action="/api/proto-role" className="mt-1.5 grid grid-cols-4 gap-1.5">
            <input type="hidden" name="returnTo" value={pathname} />
            {ROLES.map((r) => (
              <button
                key={r}
                type="submit"
                name="role"
                value={r}
                className={`rounded-md border py-1.5 text-[13px] ${r === role ? "border-brand bg-brand" : "border-white/15 bg-white/10 hover:bg-white/20"}`}
                aria-pressed={r === role}
              >
                {ROLE_LABEL[r]}
              </button>
            ))}
          </form>
          <p className="mt-2 text-xs leading-relaxed opacity-60">照片暫用系網素材，資料為虛構示範。後台入口連到後台草稿，另評選。</p>
        </>
      ) : null}
    </div>
  );
}
