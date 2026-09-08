import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { IconArrowRight, IconCrown, IconTrophy } from "@tabler/icons-react";
import type { ProjectAward } from "@/lib/fixtures";

/**
 * 前台共用區塊。視覺依系網 im.fju.edu.tw 實際截圖（docs/research/2026-09-07-design-reference.md）：
 * 首字橘色的大標、灰藍圓角標題板、暖白照片卡、深藍左線列表、橘色外框「查看更多」。
 */

/** 區塊大標：第一個字橘色（系網做法） */
export function SectionTitle({ children, align = "center", className = "" }: { children: string; align?: "center" | "start"; className?: string }) {
  const [first, ...rest] = Array.from(children);
  return (
    <h2 className={`type-section ${align === "center" ? "text-center" : ""} ${className}`}>
      <span className="text-brand">{first}</span>
      {rest.join("")}
    </h2>
  );
}

/** 灰藍圓角標題板＋橘色按鈕（系網招生訊息／產業實習） */
export function PanelTitle({ title, href, label, side = "left" }: { title: string; href: string; label: string; side?: "left" | "right" }) {
  return (
    <div className={`fju-panel-title w-full max-w-[520px] ${side === "left" ? "rounded-tr-[40px] md:-ml-10" : "rounded-tl-[40px] self-end md:-mr-10"}`}>
      <SectionTitle align="start">{title}</SectionTitle>
      <Link href={href} className="btn-fju group h-10 px-5 text-[15px]">
        {label}
        <IconArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
      </Link>
    </div>
  );
}

/** 置中的橘色外框寬按鈕（系網「查看更多」） */
export function MoreButton({ href, children = "查看更多" }: { href: string; children?: ReactNode }) {
  return (
    <Link href={href} className="btn-fju-outline press h-14 w-full max-w-[680px] text-xl">
      {children}
    </Link>
  );
}

export function Tag({ children, tone = "brand", className = "" }: { children: ReactNode; tone?: "brand" | "navy"; className?: string }) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded-[4px] border bg-background px-2 text-xs font-semibold ${
        tone === "brand" ? "border-brand text-brand" : "border-primary text-primary"
      } ${className}`}
    >
      {children}
    </span>
  );
}

/** 得獎徽章：優秀專題王冠、佳作獎盃（Roy 2026-09-07） */
export function AwardBadge({ award, label, className = "" }: { award?: ProjectAward; label?: string; className?: string }) {
  if (!award) return null;
  const excellent = award === "excellent";
  return (
    <span
      className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-bold ${
        excellent ? "bg-brand text-brand-foreground" : "bg-primary text-primary-foreground"
      } ${className}`}
      title={label}
    >
      {excellent ? <IconCrown className="size-3.5" /> : <IconTrophy className="size-3.5" />}
      {excellent ? "優秀專題" : "佳作"}
    </span>
  );
}

/** 暖白照片卡（系網得獎焦點） */
export function PhotoCard({
  href,
  image,
  alt = "",
  date,
  title,
  tags,
  children,
  priority = false,
}: {
  href: string;
  image: string;
  alt?: string;
  date?: string;
  title: string;
  tags?: ReactNode;
  children?: ReactNode;
  priority?: boolean;
}) {
  return (
    <Link href={href} className="group card-lift flex h-full flex-col overflow-hidden rounded-xl bg-secondary shadow-[0_2px_10px_rgba(0,51,102,0.08)]">
      <div className="relative aspect-video overflow-hidden bg-muted">
        <Image src={image} alt={alt} fill sizes="(max-width: 768px) 100vw, 300px" priority={priority} className="object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        {children}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4.5 text-secondary-foreground">
        {date ? <span className="tabular text-[13px] font-semibold text-muted-foreground">{date}</span> : null}
        <span className="type-card-title text-foreground">{title}</span>
        {tags ? <div className="mt-auto flex flex-wrap gap-1.5 pt-1">{tags}</div> : null}
      </div>
    </Link>
  );
}

/** 深藍左線列表項（系網招生訊息右欄、產業實習） */
export function ListItem({ href, title, meta }: { href: string; title: string; meta: ReactNode }) {
  return (
    <li className="fju-list-item flex flex-col gap-1.5 py-1.5">
      <Link href={href} className="link-ink text-[17px] font-bold leading-snug">
        {title}
      </Link>
      <div className="flex flex-wrap items-center gap-2.5">{meta}</div>
    </li>
  );
}

/** 內頁頁首帶：灰底、麵包屑、首字橘色大標 */
export function PageHead({ title, description, crumbs }: { title: string; description?: string; crumbs: { href?: string; label: string }[] }) {
  return (
    <div className="border-b border-border bg-muted/50">
      <div className="mx-auto max-w-6xl px-5 py-9">
        <nav aria-label="麵包屑" className="text-[13px] text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1.5">
            <li>
              <Link href="/" className="hover:text-foreground">首頁</Link>
            </li>
            {crumbs.map((c) => (
              <li key={c.label} className="flex items-center gap-1.5">
                <span aria-hidden>›</span>
                {c.href ? <Link href={c.href} className="hover:text-foreground">{c.label}</Link> : <span>{c.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
        <h1 className="mt-2.5 text-[34px] font-extrabold leading-tight">
          <span className="text-brand">{Array.from(title)[0]}</span>
          {Array.from(title).slice(1).join("")}
        </h1>
        {description ? <p className="mt-2.5 max-w-3xl text-[15px] text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  );
}

export { PillLink } from "./pill-link";

/** 列表狀態（規格 §10.3）：空白／無權限／無結果 */
export function ListState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-2.5 rounded-xl border border-border bg-card px-6 py-12 text-center">
      <span className="text-muted-foreground/60">{icon}</span>
      <p className="text-base font-bold">{title}</p>
      <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">{hint}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
