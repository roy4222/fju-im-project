"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const VERSIONS = [
  { href: "/", label: "V1", title: "系網延伸" },
  { href: "/v2", label: "V2", title: "時程優先" },
  { href: "/v3", label: "V3", title: "作品優先" },
  { href: "/v0", label: "舊", title: "8/17 第一版（對照）" },
];

/** 原型專用：固定在畫面底部，讓 Roy 一鍵在版本之間比較。正式版不會有這個元件。 */
export function VersionSwitcher() {
  const pathname = usePathname();

  return (
    <div data-prototype-switcher className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 print:hidden">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-background/85 p-1 shadow-lg backdrop-blur-md">
        <span className="type-eyebrow px-2.5 text-muted-foreground">原型版本</span>
        {VERSIONS.map((v) => {
          const active = pathname === v.href;
          return (
            <Link
              key={v.href}
              href={v.href}
              title={v.title}
              aria-current={active ? "page" : undefined}
              className={`press flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {v.label}
              <span className="ml-1.5 hidden opacity-70 sm:inline">{v.title}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
