import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";

/**
 * 內頁標題區。回答 apple-design §16 wayfinding 的四個問題之一：「我在哪」。
 * 麵包屑一律可點回上一層，不做只有裝飾的路徑文字。
 */
export function PageHeader({
  title,
  description,
  breadcrumb = [],
  meta,
}: {
  title: string;
  description?: string;
  breadcrumb?: { href: string; label: string }[];
  meta?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border bg-muted/40">
      <div className="mx-auto max-w-6xl px-5 py-9 md:py-12">
        <nav aria-label="路徑" className="flex flex-wrap items-center gap-1 text-xs">
          <Link href="/" className="text-muted-foreground hover:text-foreground hover:underline">
            首頁
          </Link>
          {breadcrumb.map((b) => (
            <span key={b.href} className="flex items-center gap-1">
              <IconChevronRight className="size-3.5 text-muted-foreground/60" aria-hidden />
              <Link
                href={b.href}
                className="text-muted-foreground hover:text-foreground hover:underline"
              >
                {b.label}
              </Link>
            </span>
          ))}
        </nav>

        <h1 className="type-section mt-3 max-w-3xl">{title}</h1>
        {description ? (
          <p className="mt-2.5 max-w-2xl text-[0.9375rem] leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
        {meta ? <div className="mt-4">{meta}</div> : null}
      </div>
    </div>
  );
}
