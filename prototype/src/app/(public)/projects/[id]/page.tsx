import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IconFileText, IconLock, IconPlayerPlay } from "@tabler/icons-react";
import { AwardBadge, Tag } from "@/components/public/blocks";
import { NeedLogin } from "@/components/public/need-login";
import { getProject } from "@/lib/data/catalog";
import { getViewer } from "@/lib/data/viewer";
import { PROJECTS } from "@/lib/fixtures";

export async function generateStaticParams() {
  return PROJECTS.filter((p) => p.award).map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: PageProps<"/projects/[id]">): Promise<Metadata> {
  const { id } = await params;
  const p = PROJECTS.find((x) => x.id === id);
  if (!p) return { title: "找不到作品" };
  return { title: p.title, description: p.summary, alternates: { canonical: `/projects/${id}` }, openGraph: { url: `/projects/${id}`, images: [p.image] }, robots: p.award ? undefined : { index: false } };
}

/** 專題詳情：得獎作品公開，其餘登入後（getProject 決定）。 */
export default async function ProjectDetailPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  const viewer = await getViewer();
  const data = await getProject(viewer, id);
  if (!data) notFound();
  if (!data.visible) return <NeedLogin returnTo={`/projects/${id}`} what="這件作品" />;
  const { item, detail, prev, next } = data;
  const backHref = viewer.isMember ? "/projects" : "/projects/featured";
  const backLabel = viewer.isMember ? "歷屆專題一覽" : "優秀專題";

  return (
    <div className="mx-auto grid max-w-6xl gap-12 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <article className="flex flex-col gap-5">
        <nav aria-label="麵包屑" className="text-[13px] text-muted-foreground">
          <Link href="/" className="hover:text-foreground">首頁</Link> › <Link href={backHref} className="hover:text-foreground">{backLabel}</Link> › {item.cohort} 屆
        </nav>
        <div className="flex flex-wrap gap-2">
          <AwardBadge award={item.award} label={item.awardLabel} />
          <Tag tone="navy">{item.cohort} 屆</Tag>
          <Tag tone="navy">{item.field}</Tag>
        </div>
        <h1 className="text-[32px] font-extrabold leading-snug">{item.title}</h1>
        <div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
          <Image src={item.image} alt="" fill priority sizes="(max-width: 1024px) 100vw, 820px" className="object-cover" />
          {item.hasVideo ? (
            <>
              <a href={detail.videoUrl ?? "#"} target="_blank" rel="noreferrer" className="absolute top-1/2 left-1/2 inline-flex size-18 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background/92 text-primary shadow-lg transition-transform hover:scale-105" aria-label="播放三分鐘影片">
                <IconPlayerPlay className="size-7" />
              </a>
              <span className="absolute bottom-4 left-4 rounded bg-black/60 px-2 py-1 text-xs text-white">三分鐘影片・系上 YouTube 不公開連結</span>
            </>
          ) : null}
        </div>
        <section className="flex flex-col gap-2.5">
          <h2 className="text-xl font-bold text-primary">摘要</h2>
          <p className="text-base leading-loose">{detail.abstract}</p>
        </section>
        {viewer.isMember ? (
          <section className="flex flex-col gap-2.5">
            <h2 className="text-xl font-bold text-primary">文件概述</h2>
            <ul className="grid gap-3.5 sm:grid-cols-3">
              {[["專案計畫書", "PDF・2.1 MB"], ["系統分析與設計文件", "PDF・6.4 MB"], ["成果海報", "PDF・A1・8.9 MB"]].map(([n, s]) => (
                <li key={n}>
                  <a href="#" className="flex items-center gap-2.5 rounded-[10px] border border-border p-4 hover:border-brand">
                    <IconFileText className="size-5 text-brand" />
                    <span className="flex flex-col">
                      <span className="text-sm font-bold">{n}</span>
                      <span className="text-xs text-muted-foreground">{s}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          /* 訪客邊界（Codex 09-10 A-07）：公開＝摘要、海報、影片入口；組員名單、文件與完整資料登入後才看 */
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <IconLock className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
              <div>
                <h2 className="text-base font-bold text-primary">登入後可看完整資料</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">組員名單、指導老師、使用技術與文件（計畫書、設計文件、海報 PDF）只提供本系學生與老師。公開的是摘要、海報預覽與影片入口。</p>
              </div>
            </div>
            <Link href={`/login?returnTo=${encodeURIComponent(`/projects/${id}`)}`} className="btn-fju h-11 shrink-0 px-6 text-[15px]">登入</Link>
          </section>
        )}
        <nav className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2" aria-label="上一件與下一件">
          {prev ? <Link href={`/projects/${prev.id}`} className="flex flex-col gap-1 hover:text-brand"><span className="text-xs text-muted-foreground">‹ 上一件</span><span className="font-bold">{prev.title}</span></Link> : <span />}
          {next ? <Link href={`/projects/${next.id}`} className="flex flex-col gap-1 text-right hover:text-brand"><span className="text-xs text-muted-foreground">下一件 ›</span><span className="font-bold">{next.title}</span></Link> : null}
        </nav>
      </article>
      <aside className="flex flex-col gap-4 lg:pt-11">
        <dl className="flex flex-col gap-3 rounded-xl bg-secondary p-5.5 text-secondary-foreground">
          {(viewer.isMember
            ? [["組別", `${item.groupNo}・${item.field}`], ["指導老師", detail.advisor], ["組員", detail.members.length ? detail.members.join("、") : "（未補登）"], ["使用技術", detail.tech.length ? detail.tech.join("、") : "（未補登）"], ["獎項", item.awardLabel ?? "—"]]
            : [["屆別", `${item.cohort} 屆・${item.field}`], ["獎項", item.awardLabel ?? "—"], ["組員與老師", "登入後顯示"]]
          ).map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className={`font-bold leading-relaxed ${v === "登入後顯示" ? "text-muted-foreground" : "text-foreground"}`}>{v}</dd>
            </div>
          ))}
        </dl>
        {item.hasPoster ? (
          <figure className="flex flex-col items-center gap-2">
            <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl bg-muted">
              <Image src={item.image} alt="成果海報" fill sizes="340px" className="object-cover" />
            </div>
            <figcaption className="text-[13px] text-muted-foreground">成果海報（點擊放大）</figcaption>
          </figure>
        ) : null}
        <Link href={backHref} className="btn-fju-outline h-12 text-base">
          回到{backLabel}
        </Link>
      </aside>
    </div>
  );
}
