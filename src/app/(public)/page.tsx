import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";
import { IconArrowRight, IconClock, IconPlayerPlay } from "@tabler/icons-react";
import { Carousel } from "@/components/public/carousel";
import { ListItem, MoreButton, PanelTitle, PhotoCard, SectionTitle, Tag } from "@/components/public/blocks";
import { QuickLinks, WorkStrip } from "@/components/public/home-blocks";
import { Reveal } from "@/components/public/ux/reveal";
import { listCompetitions, listFeaturedProjects, listHonors, listNews, listProjects, listUpcoming, listWork } from "@/lib/data/catalog";
import { getViewer, workbenchHref, workbenchLabel } from "@/lib/data/viewer";
import { AwardBadge } from "@/components/public/blocks";

export const metadata: Metadata = {
  title: "首頁",
  alternates: { canonical: "/" },
  openGraph: { url: "/", images: ["/placeholder/campus.jpg"] },
};

/**
 * 公開首頁（2026-09-07 方向 A 定案，區塊交錯）：
 * hero → [登入後：我的工作＋近期截止] → 最新公告（照片卡＋列表）
 * → [登入後：歷屆專題一覽 影片卡] → 優秀專題（四欄輪播）
 * → 榮譽與競賽（大照片＋列表＋進行中競賽）→ 快速入口 → 頁尾
 */
export default async function HomePage() {
  const viewer = await getViewer();
  const [news, featured, honors, competitions, work, due, archive] = await Promise.all([
    listNews(viewer),
    listFeaturedProjects(),
    listHonors(),
    listCompetitions({ status: "open" }),
    listWork(viewer),
    listUpcoming(viewer),
    listProjects(viewer, { sort: "cohort" }),
  ]);
  const member = viewer.isMember;
  const workbench = { label: workbenchLabel(viewer.role), href: workbenchHref(viewer.role) };

  return (
    <>
      {/* Hero：照片＋深藍漸層（系網首屏是照片，不是文字 hero） */}
      <section className="relative overflow-hidden bg-primary text-primary-foreground" aria-label="專題管理平台">
        <Image src="/placeholder/campus.jpg" alt="" fill priority sizes="100vw" className="object-cover opacity-55" />
        <div className="absolute inset-0 bg-gradient-to-r from-primary/95 via-primary/55 to-primary/15" aria-hidden />
        <div className="relative mx-auto flex min-h-[520px] max-w-6xl flex-col justify-center gap-5 px-5 py-16">
          <span className="inline-flex items-center gap-2.5 text-[15px] font-bold tracking-widest opacity-90">
            <span className="inline-block h-0.75 w-7 bg-brand" aria-hidden />
            114 學年度資訊管理學系專題
          </span>
          <h1 className="type-display max-w-2xl text-white">
            專題公告、規則
            <br />
            與歷屆成果
          </h1>
          <p className="max-w-lg text-[17px] leading-relaxed opacity-90">本系專題的公開資訊入口。學生與指導老師登入後，於同一平台完成分組、文件繳交、評分與線上同意。</p>
          <div className="mt-2 flex flex-wrap gap-3.5">
            <Link href="/news" className="btn-fju h-12 px-7 text-[17px]">
              查看最新公告 <IconArrowRight className="size-4.5" />
            </Link>
            <Link href={member ? "/projects" : "/projects/featured"} className="btn-fju-ghost h-12 px-7 text-[17px]">
              {member ? "查看歷屆專題一覽" : "查看優秀專題"}
            </Link>
          </div>
        </div>
      </section>

      {member ? <WorkStrip role={viewer.role} work={work} due={due} workbench={workbench} /> : null}

      {/* 最新公告：左兩張照片卡＋右四則列表（系網招生訊息版型） */}
      <section className="mx-auto max-w-6xl px-5 pt-20" aria-labelledby="home-news">
        <Reveal>
        <div id="home-news">
          <PanelTitle title="最新公告" href="/news" label="查看更多" />
        </div>
        <div className="mt-10 grid gap-8 lg:grid-cols-[300px_300px_minmax(0,1fr)]">
          {news.slice(0, 2).map((n, i) => (
            <PhotoCard key={n.id} href={`/news/${n.id}`} image={n.image} date={n.date} title={n.title} tags={<Tag>{n.category}</Tag>} priority={i === 0} />
          ))}
          <ul className="flex flex-col gap-5 pt-1.5">
            {news.slice(2, 6).map((n) => (
              <ListItem key={n.id} href={`/news/${n.id}`} title={n.title} meta={<><span className="tabular text-[13px] font-semibold text-muted-foreground">{n.date}</span><Tag>{n.category}</Tag></>} />
            ))}
          </ul>
        </div>
        </Reveal>
      </section>

      {member && archive.length > 0 ? (
        <section className="mt-24 bg-muted/50 py-20" aria-labelledby="home-archive">
          <Reveal>
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-9 px-5">
            <div className="flex flex-col items-center gap-2">
              <SectionTitle>歷屆專題一覽</SectionTitle>
              <p className="text-[15px] text-muted-foreground">登入後的學習參考庫：三分鐘影片、摘要、海報與文件概述</p>
            </div>
            <div className="w-full">
              <Carousel
                label="歷屆專題"
                perView={3}
                items={archive.slice(0, 6).map((p) => (
                  <Link key={p.id} href={`/projects/${p.id}`} className="group flex flex-col gap-2.5">
                    <div className="relative aspect-video overflow-hidden rounded-[10px] bg-muted">
                      <Image src={p.image} alt="" fill sizes="(max-width: 640px) 100vw, 380px" className="object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                      {p.hasVideo ? <span className="absolute top-1/2 left-1/2 inline-flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-primary"><IconPlayerPlay className="size-5" /></span> : null}
                      <span className="absolute top-3 left-3"><Tag tone="navy">{p.cohort} 屆</Tag></span>
                    </div>
                    <span className="text-[17px] font-bold group-hover:text-brand">{p.title}</span>
                    <span className="text-[13px] text-muted-foreground">{p.groupNo}・{p.advisor}</span>
                  </Link>
                ))}
              />
            </div>
            <MoreButton href="/projects">進入歷屆專題一覽</MoreButton>
          </div>
          </Reveal>
        </section>
      ) : null}

      {/* 優秀專題：四欄輪播（系網得獎焦點） */}
      <section className={`py-20 ${member ? "" : "mt-24 bg-muted/50"}`} aria-labelledby="home-featured">
        <Reveal>
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-9 px-5">
          <SectionTitle>優秀專題</SectionTitle>
          <div className="w-full">
            <Carousel
              label="優秀專題"
              items={featured.map((p) => (
                <PhotoCard key={p.id} href={`/projects/${p.id}`} image={p.image} title={p.title} tags={<><Tag tone="navy">{p.cohort} 屆</Tag><Tag>{p.field}</Tag></>}>
                  <AwardBadge award={p.award} label={p.awardLabel} className="absolute top-3 left-3 shadow-md" />
                </PhotoCard>
              ))}
            />
          </div>
          <MoreButton href="/projects/featured" />
        </div>
        </Reveal>
      </section>

      {/* 榮譽與競賽：左大照片＋右標題板與列表（系網產業實習鏡射） */}
      <section className="mt-4" aria-labelledby="home-honors">
        <Reveal>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_760px]">
          <div className="relative min-h-[320px] lg:min-h-[520px]">
            <Image src={honors[0]?.image ?? "/placeholder/applause.jpg"} alt="" fill sizes="(max-width: 1024px) 100vw, 680px" className="object-cover" />
          </div>
          <div className="flex flex-col">
            <PanelTitle title="榮譽與競賽" href="/honors" label="查看更多" side="right" />
            <ul className="flex flex-col gap-5 px-5 py-10 lg:pr-40 lg:pl-14">
              {honors.slice(0, 4).map((h) => (
                <ListItem key={h.id} href={`/honors?item=${h.id}`} title={`${h.competition} ${h.award}`} meta={<><span className="tabular text-[13px] font-semibold text-muted-foreground">{h.date}</span><Tag>榮譽榜</Tag><Tag tone="navy">{h.team}</Tag></>} />
              ))}
            </ul>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 pt-10">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-primary">進行中的競賽</h3>
            <Link href="/competitions" className="text-sm font-semibold text-brand hover:underline">
              全部競賽資訊 →
            </Link>
          </div>
          <ul className="grid gap-4 md:grid-cols-3">
            {competitions.slice(0, 3).map((c) => (
              <li key={c.id}>
                <Link href={`/competitions#${c.id}`} className="flex h-full flex-col gap-1.5 rounded-[10px] border border-border bg-card p-4.5 transition-colors hover:border-brand">
                  <span className="flex items-center gap-2">
                    <Tag tone={c.status === "open" ? "brand" : "navy"}>{c.status === "open" ? "報名中" : c.status === "result" ? "決賽" : "已結束"}</Tag>
                    <span className="tabular inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground"><IconClock className="size-3.5" />{c.status === "open" ? `截止 ${c.deadline.slice(5).replace("-", "/")}` : c.eventDate ? c.eventDate.slice(5).replace("-", "/") : c.deadline}</span>
                  </span>
                  <span className="text-[15px] font-bold leading-snug">{c.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        </Reveal>
      </section>

      <Reveal className="mt-24">
        <QuickLinks role={viewer.role} />
      </Reveal>
    </>
  );
}
