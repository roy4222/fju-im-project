import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IconArrowRight, IconFileText } from "@tabler/icons-react";
import { ListItem, Tag } from "@/components/public/blocks";
import { NeedLogin } from "@/components/public/need-login";
import { getNews } from "@/lib/data/catalog";
import { getViewer } from "@/lib/data/viewer";
import { MANAGED_ITEMS, NEWS } from "@/lib/fixtures";

export async function generateStaticParams() {
  return NEWS.filter((n) => !n.audience || n.audience === "public").map((n) => ({ id: n.id }));
}

export async function generateMetadata({ params }: PageProps<"/news/[id]">): Promise<Metadata> {
  const { id } = await params;
  const n = NEWS.find((x) => x.id === id);
  if (!n) return { title: "找不到公告" };
  return { title: n.title, description: n.summary, alternates: { canonical: `/news/${id}` }, openGraph: { url: `/news/${id}`, images: [n.image] } };
}

export default async function NewsDetailPage({ params }: PageProps<"/news/[id]">) {
  const { id } = await params;
  const viewer = await getViewer();
  const data = await getNews(viewer, id);
  if (!data) notFound();
  if (!data.visible) return <NeedLogin returnTo={`/news/${id}`} what="這則公告" />;
  const { item, body, related, prev, next } = data;
  // 0715 §10「發公告 → 跳頁面填寫」：公告若對應收件項目，給登入者一顆前往填寫的按鈕
  const linked = item.category === "專題事務" ? MANAGED_ITEMS.find((m) => item.title.includes(m.title.slice(0, 6))) : undefined;

  return (
    <div className="mx-auto grid max-w-6xl gap-12 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <article className="flex flex-col gap-5">
        <nav aria-label="麵包屑" className="text-[13px] text-muted-foreground">
          <Link href="/" className="hover:text-foreground">首頁</Link> › <Link href="/news" className="hover:text-foreground">最新公告</Link> › <Link href={`/news?category=${item.category}`} className="hover:text-foreground">{item.category}</Link>
        </nav>
        <div className="flex items-center gap-2.5">
          <Tag>{item.category}</Tag>
          <time dateTime={item.date} className="tabular text-[13px] font-semibold text-muted-foreground">{item.date}</time>
        </div>
        <h1 className="text-[32px] font-extrabold leading-snug">{item.title}</h1>
        <div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
          <Image src={item.image} alt="" fill priority sizes="(max-width: 1024px) 100vw, 820px" className="object-cover" />
        </div>
        <div className="flex flex-col gap-4 text-[17px] leading-loose">
          {body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        {linked && viewer.isMember ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-brand-subtle p-5 text-brand-on-subtle">
            <div>
              <p className="font-bold">相關專題事務：{linked.title}</p>
              <p className="text-sm">截止 {linked.dueAt}・整組一份，任一成員送出即代表全組完成</p>
            </div>
            <Link href={`/dashboard/${viewer.role}/affairs`} className="btn-fju h-10 px-4 text-sm">
              前往填寫 <IconArrowRight className="size-4" />
            </Link>
          </div>
        ) : null}
        {item.attachments ? (
          <section className="flex flex-col gap-2.5 rounded-[10px] border border-border p-5" aria-label="附件">
            <p className="font-bold">附件</p>
            {Array.from({ length: item.attachments }).map((_, i) => (
              <a key={i} href="#" className="flex items-center gap-2.5 text-primary hover:text-brand">
                <IconFileText className="size-5" />
                <span className="font-semibold">{i === 0 ? "114 專題分組作業說明.pdf" : "指導老師名單與研究領域.pdf"}</span>
                <span className="text-[13px] text-muted-foreground">{i === 0 ? "312 KB" : "188 KB"}</span>
              </a>
            ))}
          </section>
        ) : null}
        <nav className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2" aria-label="上一則與下一則">
          {prev ? (
            <Link href={`/news/${prev.id}`} className="flex flex-col gap-1 hover:text-brand">
              <span className="text-xs text-muted-foreground">‹ 上一則</span>
              <span className="font-bold">{prev.title}</span>
            </Link>
          ) : <span />}
          {next ? (
            <Link href={`/news/${next.id}`} className="flex flex-col gap-1 text-right hover:text-brand">
              <span className="text-xs text-muted-foreground">下一則 ›</span>
              <span className="font-bold">{next.title}</span>
            </Link>
          ) : null}
        </nav>
      </article>
      <aside className="flex flex-col gap-4 lg:pt-11">
        <h2 className="text-lg font-bold">同分類公告</h2>
        <ul className="flex flex-col gap-4">
          {related.map((r) => (
            <ListItem key={r.id} href={`/news/${r.id}`} title={r.title} meta={<span className="tabular text-[13px] font-semibold text-muted-foreground">{r.date}</span>} />
          ))}
        </ul>
        <Link href="/news" className="btn-fju-outline mt-2 h-12 text-base">
          回到公告列表
        </Link>
      </aside>
    </div>
  );
}
