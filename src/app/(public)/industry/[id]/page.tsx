import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IconLock } from "@tabler/icons-react";
import { Tag } from "@/components/public/blocks";
import { NeedLogin } from "@/components/public/need-login";
import { getIndustry } from "@/lib/data/catalog";
import { getViewer } from "@/lib/data/viewer";
import { GROUPS, INDUSTRY } from "@/lib/fixtures";

export async function generateMetadata({ params }: PageProps<"/industry/[id]">): Promise<Metadata> {
  const { id } = await params;
  const i = INDUSTRY.find((x) => x.id === id);
  return { title: i ? `${i.company}｜${i.title}` : "找不到合作案", robots: { index: false }, alternates: { canonical: `/industry/${id}` } };
}

export default async function IndustryDetailPage({ params }: PageProps<"/industry/[id]">) {
  const { id } = await params;
  const viewer = await getViewer();
  if (!viewer.isMember) return <NeedLogin returnTo={`/industry/${id}`} what="產學合作詳情" />;
  const { item, detail, canSeeContact } = await getIndustry(viewer, id);
  if (!item || !detail) notFound();
  const linked = GROUPS.filter((g) => g.industryId === id);

  return (
    <div className="mx-auto grid max-w-6xl gap-12 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <article className="flex flex-col gap-5">
        <nav aria-label="麵包屑" className="text-[13px] text-muted-foreground">
          <Link href="/" className="hover:text-foreground">首頁</Link> › <Link href="/industry" className="hover:text-foreground">產學合作</Link> › {item.company}
        </nav>
        <div className="flex gap-2">
          {item.status === "claimed" ? <Tag tone="navy">已有 {item.linkedGroups} 組</Tag> : <Tag>未指派</Tag>}
          <Tag tone="navy">114 學年度</Tag>
        </div>
        <h1 className="text-[32px] font-extrabold leading-snug">{item.title}</h1>
        <dl className="grid gap-3.5 sm:grid-cols-3">
          {[["公司名稱", item.company], ["需求部門", item.department], ["負責老師", `${item.advisorName}・${item.publishedAt} 發布`]].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 rounded-[10px] border border-border p-4">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="font-bold">{v}</dd>
            </div>
          ))}
        </dl>
        <section className="flex flex-col gap-2.5"><h2 className="text-xl font-bold text-primary">專題／合作內容</h2><p className="text-base leading-loose">{detail.publicFields.content}</p></section>
        <section className="flex flex-col gap-2.5"><h2 className="text-xl font-bold text-primary">對學生的條件／需求</h2><p className="text-base leading-loose">{detail.publicFields.requirement}</p></section>
        {detail.publicFields.note ? <section className="flex flex-col gap-2.5"><h2 className="text-xl font-bold text-primary">備註</h2><p className="text-base leading-loose">{detail.publicFields.note}</p></section> : null}
      </article>
      <aside className="flex flex-col gap-4 lg:pt-11">
        <div className={`flex flex-col gap-2.5 rounded-xl p-5.5 ${canSeeContact ? "bg-secondary" : "border border-dashed border-border"}`}>
          <p className="flex items-center gap-2 font-bold">
            {!canSeeContact ? <IconLock className="size-4 text-muted-foreground" aria-hidden /> : null}
            聯絡資訊
          </p>
          {canSeeContact ? (
            <dl className="flex flex-col gap-1.5 text-sm">
              {[["地址", detail.privateFields.address], ["聯絡人", detail.privateFields.contact], ["電話", detail.privateFields.phone], ["Email", detail.privateFields.email]].map(([k, v]) => (
                <div key={k} className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">{k}</dt><dd>{v}</dd></div>
              ))}
              <p className="mt-1 text-xs text-muted-foreground">原型為遮罩示範；正式版由伺服器依身分回傳。</p>
            </dl>
          ) : (
            <p className="text-[13px] leading-relaxed text-muted-foreground">公司地址、聯絡人、電話與 Email 僅負責老師與系辦可見。學生請透過指導老師聯繫。</p>
          )}
        </div>
        <div className="flex flex-col gap-2.5 rounded-xl bg-secondary p-5.5 text-secondary-foreground">
          <p className="font-bold text-foreground">連結的組別</p>
          {linked.length ? linked.map((g) => (
            <div key={g.id} className="flex flex-col"><span className="font-bold text-foreground">{g.no}</span><span className="text-sm text-muted-foreground">{g.title}</span></div>
          )) : <p className="text-sm text-muted-foreground">尚未有組別連結。指導老師可於工作台認領。</p>}
        </div>
        <Link href="/industry" className="btn-fju-outline h-12 text-base">回到產學合作列表</Link>
      </aside>
    </div>
  );
}
