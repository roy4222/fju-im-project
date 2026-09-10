import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { IconArrowRight, IconLock, IconSearch, IconSearchOff } from "@tabler/icons-react";
import { ListState, PageHead, PhotoCard, PillLink, Tag } from "@/components/public/blocks";
import { NEWS_CATEGORIES, listNews } from "@/lib/data/catalog";
import { getViewer } from "@/lib/data/viewer";

export const metadata: Metadata = {
  title: "最新公告",
  description: "輔大資管系專題公告：專題事務、競賽資訊、活動與規則異動。",
  alternates: { canonical: "/news" },
  openGraph: { url: "/news" },
};

const PER_PAGE = 9;

export default async function NewsPage({ searchParams }: PageProps<"/news">) {
  const sp = await searchParams;
  const category = typeof sp.category === "string" ? sp.category : "全部";
  const q = typeof sp.q === "string" ? sp.q : "";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const viewer = await getViewer();
  const items = await listNews(viewer, { category, q });
  const pinned = page === 1 && !q ? items.find((n) => n.pinned) : undefined;
  const rest = items.filter((n) => n !== pinned);
  const pages = Math.max(1, Math.ceil(rest.length / PER_PAGE));
  const slice = rest.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const link = (p: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    const merged = { category, q, page: 1, ...p };
    Object.entries(merged).forEach(([k, v]) => { if (v && v !== "全部" && v !== 1) u.set(k, String(v)); });
    const s = u.toString();
    return `/news${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <PageHead title="最新公告" description="專題事務、競賽資訊、活動與規則異動。置頂公告固定在最上方，其餘依日期排序。" crumbs={[{ label: "最新公告" }]} />
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-10">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <nav className="flex flex-wrap gap-2" aria-label="公告分類">
            {NEWS_CATEGORIES.map((c) => (
              <PillLink key={c} href={link({ category: c })} active={c === category} tone="brand">
                {c}
              </PillLink>
            ))}
          </nav>
          <form action="/news" className="relative">
            {category !== "全部" ? <input type="hidden" name="category" value={category} /> : null}
            <label className="sr-only" htmlFor="news-q">搜尋公告</label>
            <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input id="news-q" name="q" defaultValue={q} placeholder="搜尋公告" className="h-10 w-64 rounded-md border border-input bg-background pr-3 pl-9 text-sm" />
          </form>
        </div>

        {pinned ? (
          <Link href={`/news/${pinned.id}`} className="group grid overflow-hidden rounded-xl bg-secondary shadow-[0_2px_10px_rgba(0,51,102,0.08)] md:grid-cols-[560px_minmax(0,1fr)]">
            <div className="relative aspect-video md:aspect-auto md:min-h-[315px]">
              <Image src={pinned.image} alt="" fill priority sizes="(max-width: 768px) 100vw, 560px" className="object-cover" />
            </div>
            <div className="flex flex-col justify-center gap-3.5 p-8">
              <div className="flex items-center gap-2">
                <Tag className="bg-brand text-brand-foreground">置頂</Tag>
                <Tag>{pinned.category}</Tag>
                <span className="tabular text-[13px] font-semibold text-muted-foreground">{pinned.date}</span>
              </div>
              <h2 className="text-[26px] font-extrabold leading-snug group-hover:text-brand">{pinned.title}</h2>
              <p className="text-[15px] leading-relaxed text-muted-foreground">{pinned.summary}</p>
              <span className="inline-flex items-center gap-1.5 font-bold text-brand">閱讀全文 <IconArrowRight className="size-4" /></span>
            </div>
          </Link>
        ) : null}

        {slice.length === 0 ? (
          <ListState icon={<IconSearchOff className="size-9" />} title={q ? `找不到符合「${q}」的公告` : "這個分類目前沒有公告"} hint="換個關鍵字，或清除篩選條件。" action={<Link href="/news" className="font-bold text-brand hover:underline">清除條件</Link>} />
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {slice.map((n) => (
              <li key={n.id}>
                <PhotoCard href={`/news/${n.id}`} image={n.image} date={n.date} title={n.title} tags={<><Tag>{n.category}</Tag>{n.audience && n.audience !== "public" ? <Tag tone="navy"><IconLock className="mr-1 size-3" />登入可見</Tag> : null}</>} />
              </li>
            ))}
          </ul>
        )}

        {pages > 1 ? (
          <nav className="flex items-center justify-center gap-2" aria-label="分頁">
            {Array.from({ length: pages }).map((_, i) => (
              <Link key={i} href={link({ page: i + 1 })} aria-current={page === i + 1 ? "page" : undefined} className={`inline-flex size-10 items-center justify-center rounded-[4px] font-semibold ${page === i + 1 ? "bg-brand text-brand-foreground" : "border border-border hover:bg-accent"}`}>
                {i + 1}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
    </>
  );
}
