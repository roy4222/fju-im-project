import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft, IconDownload, IconPaperclip } from "@tabler/icons-react";
import { PageHeader } from "@/components/public/page-header";
import { ImagePlaceholder } from "@/components/public/sections";
import { Badge } from "@/components/ui/badge";
import { NEWS, NEWS_BODY } from "@/lib/fixtures";

export function generateStaticParams() {
  return NEWS.map((n) => ({ id: n.id }));
}

export async function generateMetadata({ params }: PageProps<"/news/[id]">) {
  const { id } = await params;
  const item = NEWS.find((n) => n.id === id);
  return { title: item?.title ?? "公告" };
}

export default async function NewsDetailPage({ params }: PageProps<"/news/[id]">) {
  const { id } = await params;
  const item = NEWS.find((n) => n.id === id);
  if (!item) notFound();

  const body = NEWS_BODY[item.id] ?? [item.summary];
  const related = NEWS.filter((n) => n.id !== item.id && n.category === item.category).slice(0, 3);

  return (
    <>
      <PageHeader
        title={item.title}
        breadcrumb={[{ href: "/news", label: "公告" }]}
        meta={
          <div className="flex flex-wrap items-center gap-3">
            <Badge
              variant="outline"
              className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
            >
              {item.category}
            </Badge>
            <time className="tabular text-sm text-muted-foreground" dateTime={item.date}>
              發布日期 {item.date}
            </time>
            {item.attachments ? (
              <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                <IconPaperclip className="size-4" />
                {item.attachments} 個附件
              </span>
            ) : null}
          </div>
        }
      />

      <article className="mx-auto max-w-3xl px-5 py-10 md:py-14">
        {/* 0715 §9：公告點開為「圖片 + 文字」 */}
        <ImagePlaceholder
          className="aspect-[16/9] rounded-xl border border-border"
          note="公告圖片待提供"
        />

        <div className="mt-8 space-y-5">
          {body.map((p, i) => (
            <p key={i} className="text-[1.0625rem] leading-[1.9] text-foreground/90">
              {p}
            </p>
          ))}
        </div>

        {item.attachments ? (
          <section className="mt-10 rounded-xl border border-border bg-card">
            <h2 className="border-b border-border px-5 py-3 text-sm font-semibold">附件下載</h2>
            <ul className="divide-y divide-border">
              {Array.from({ length: item.attachments }).map((_, i) => (
                <li key={i} className="flex items-center gap-3 px-5 py-3.5">
                  <IconPaperclip className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {i === 0 ? "分組名單確認表_說明.pdf" : "指導老師意願調查_填寫範例.pdf"}
                  </span>
                  <span className="tabular shrink-0 text-xs text-muted-foreground">
                    {i === 0 ? "412 KB" : "268 KB"}
                  </span>
                  <button
                    type="button"
                    className="press inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-xs font-medium transition-colors hover:bg-accent"
                  >
                    <IconDownload className="size-3.5" />
                    下載
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mt-10 border-t border-border pt-6">
          <Link
            href="/news"
            className="press inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <IconArrowLeft className="size-4" />
            回到公告列表
          </Link>
        </div>

        {related.length > 0 ? (
          <section className="mt-12">
            <h2 className="type-card-title mb-4">同分類的其他公告</h2>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {related.map((n) => (
                <li key={n.id}>
                  <Link
                    href={`/news/${n.id}`}
                    className="press group flex items-baseline gap-4 px-4 py-3.5 transition-colors hover:bg-accent/45"
                  >
                    <time className="tabular shrink-0 text-xs text-muted-foreground">
                      {n.date}
                    </time>
                    <span className="min-w-0 flex-1 text-sm font-medium group-hover:text-primary">
                      {n.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </article>
    </>
  );
}
