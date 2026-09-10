"use client";

import Link, { useLinkStatus } from "next/link";
import type { ReactNode } from "react";

function Pending() {
  const { pending } = useLinkStatus();
  return <span aria-hidden className={`pill-dot ${pending ? "is-pending" : ""}`} />;
}

/** pill 篩選（連結版，用 searchParams）。按下有縮放回饋、換頁中有小點提示。 */
export function PillLink({ href, active, children, tone = "navy" }: { href: string; active: boolean; children: ReactNode; tone?: "navy" | "brand" }) {
  const activeCls = tone === "brand" ? "border-brand bg-brand text-brand-foreground" : "border-primary bg-primary text-primary-foreground";
  const idleCls = tone === "brand" ? "border-brand text-brand hover:bg-brand-subtle" : "border-border text-foreground hover:border-primary/40 hover:bg-accent";
  return (
    <Link
      href={href}
      scroll={false}
      className={`press relative inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-[background-color,border-color,color,transform,box-shadow] duration-200 ${active ? `${activeCls} shadow-[0_2px_8px_rgba(0,51,102,0.18)]` : idleCls}`}
      aria-current={active ? "true" : undefined}
    >
      {children}
      <Pending />
    </Link>
  );
}
