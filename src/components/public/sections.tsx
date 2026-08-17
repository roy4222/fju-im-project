import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowRight, IconPhoto, IconPlayerPlay } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";

/**
 * 公開前台的共用區塊元件。
 *
 * 視覺依據是系網（im.fju.edu.tw）實際的手法：置中的區塊標題、橘色強調、
 * 圖在上文在下的卡片、置中的橘色外框膠囊「查看更多」。
 * 差異：系網把標題前兩字染橘（Elementor 的視覺 hack，語意上把詞切開），
 * 這裡改成標題上方一條短橘線，視覺重量相同但語意乾淨。
 */

export function SectionHeading({
  title,
  description,
  align = "center",
}: {
  title: string;
  description?: string;
  align?: "center" | "start";
}) {
  const center = align === "center";
  return (
    <div className={`mb-8 ${center ? "text-center" : ""}`}>
      <span
        aria-hidden
        className={`block h-0.5 w-10 rounded-full bg-brand ${center ? "mx-auto" : ""}`}
      />
      <h2 className="type-section mt-4">{title}</h2>
      {description ? (
        <p
          className={`mt-2.5 text-[0.9375rem] leading-relaxed text-muted-foreground ${
            center ? "mx-auto max-w-xl" : "max-w-xl"
          }`}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** 置中的橘色外框膠囊按鈕，系網的「查看更多」樣式 */
export function MoreLink({
  href,
  children = "查看更多",
  className = "",
}: {
  href: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`press inline-flex h-10 items-center gap-1.5 rounded-full border border-brand/50 px-5 text-sm font-medium text-brand-on-subtle transition-colors hover:border-brand hover:bg-brand-subtle ${className}`}
    >
      {children}
      <IconArrowRight className="size-4" />
    </Link>
  );
}

/** 區塊容器：負責一致的垂直節奏。一屏一件事，區塊之間留白要夠。 */
export function Section({
  children,
  className = "",
  tone = "default",
  id,
}: {
  children: ReactNode;
  className?: string;
  tone?: "default" | "muted";
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`${tone === "muted" ? "bg-muted/45" : ""} py-16 md:py-24 ${className}`}
    >
      <div className="mx-auto max-w-6xl px-5">{children}</div>
    </section>
  );
}

/**
 * 圖片佔位。
 *
 * 刻意做成中性灰底 + 圖示 + 註記，而不是用飽和品牌色填滿——
 * 系網那些位置放的是真實照片，用大面積橘／藍色塊冒充會直接變成
 * docs/ANTI-PATTERNS.md 第 4 條講的裝飾性色塊。中性佔位一眼就看得出
 * 「這裡等照片」，也不會干擾旁邊的內容判讀。
 */
export function ImagePlaceholder({
  label,
  className = "",
  note = "照片待提供",
  onDark = false,
}: {
  label?: string;
  /** 保留參數以相容呼叫端；中性佔位不再依色調區分 */
  tone?: 1 | 2 | 3 | 4 | 5;
  className?: string;
  note?: string;
  /** 放在深色底上時用較深的中性色，避免變成一塊發亮的空白 */
  onDark?: boolean;
}) {
  return (
    <div
      className={`relative flex items-end justify-start ${
        onDark ? "bg-white/8" : "border-b border-border bg-muted"
      } ${className}`}
    >
      <span
        className={`absolute inset-0 flex flex-col items-center justify-center gap-1.5 ${
          onDark ? "text-white/45" : "text-muted-foreground/55"
        }`}
      >
        <IconPhoto className="size-7" strokeWidth={1.5} />
        <span className="text-[11px]">{note}</span>
      </span>
      {label ? (
        <span className="relative m-3 rounded bg-background/85 px-2 py-1 text-[11px] font-medium text-foreground shadow-sm">
          {label}
        </span>
      ) : null}
    </div>
  );
}

/** 內容卡：圖在上、文在下，系網的卡片結構 */
export function ContentCard({
  href,
  imageTone = 1,
  imageLabel,
  category,
  date,
  title,
  summary,
  hasVideo,
  badge,
}: {
  href: string;
  imageTone?: 1 | 2 | 3 | 4 | 5;
  imageLabel?: string;
  category?: string;
  date?: string;
  title: string;
  summary?: string;
  hasVideo?: boolean;
  badge?: string;
}) {
  return (
    <Link
      href={href}
      className="press group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-brand/45"
    >
      <ImagePlaceholder tone={imageTone} label={imageLabel} className="aspect-[16/10]" />
      <div className="flex flex-1 flex-col p-4">
        <div className="flex flex-wrap items-center gap-2">
          {category ? (
            <Badge
              variant="outline"
              className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
            >
              {category}
            </Badge>
          ) : null}
          {badge ? (
            <Badge variant="outline" className="text-[11px] text-muted-foreground">
              {badge}
            </Badge>
          ) : null}
          {hasVideo ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <IconPlayerPlay className="size-3" />
              影片
            </span>
          ) : null}
          {date ? (
            <time className="tabular ml-auto text-xs text-muted-foreground" dateTime={date}>
              {date}
            </time>
          ) : null}
        </div>
        <h3 className="type-card-title mt-2.5 group-hover:text-primary">{title}</h3>
        {summary ? (
          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {summary}
          </p>
        ) : null}
      </div>
    </Link>
  );
}
