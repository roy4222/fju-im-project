import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft, IconLock, IconUsersGroup } from "@tabler/icons-react";
import { PageHeader } from "@/components/public/page-header";
import { Badge } from "@/components/ui/badge";
import { GROUPS, INDUSTRY, INDUSTRY_DETAIL } from "@/lib/fixtures";

export function generateStaticParams() {
  return INDUSTRY.map((i) => ({ id: i.id }));
}

export async function generateMetadata({ params }: PageProps<"/industry/[id]">) {
  const { id } = await params;
  const item = INDUSTRY.find((i) => i.id === id);
  return { title: item?.title ?? "產學合作" };
}

export default async function IndustryDetailPage({ params }: PageProps<"/industry/[id]">) {
  const { id } = await params;
  const item = INDUSTRY.find((i) => i.id === id);
  if (!item) notFound();

  const detail = INDUSTRY_DETAIL[item.id];
  const linked = GROUPS.filter((g) => g.industryId === item.id);

  return (
    <>
      <PageHeader
        title={item.title}
        breadcrumb={[{ href: "/industry", label: "產學合作" }]}
        meta={
          <div className="flex flex-wrap items-center gap-3">
            {item.status === "open" ? (
              <Badge
                variant="outline"
                className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
              >
                未指派組別
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[11px] text-muted-foreground">
                已有 {item.linkedGroups} 組
              </Badge>
            )}
            <time className="tabular text-sm text-muted-foreground">
              發布日期 {item.publishedAt}
            </time>
          </div>
        }
      />

      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-10 md:py-14 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <article>
          <section>
            <h2 className="type-card-title text-lg">專題／合作內容</h2>
            <p className="mt-3 text-[1.0625rem] leading-[1.9] text-foreground/90">
              {detail.publicFields.content}
            </p>
          </section>

          <section className="mt-9 border-t border-border pt-8">
            <h2 className="type-card-title text-lg">對學生的條件與需求</h2>
            <p className="mt-3 text-[1.0625rem] leading-[1.9] text-foreground/90">
              {detail.publicFields.requirement}
            </p>
          </section>

          {detail.publicFields.note ? (
            <section className="mt-9 border-t border-border pt-8">
              <h2 className="type-card-title text-lg">備註</h2>
              <p className="mt-3 text-[1.0625rem] leading-[1.9] text-foreground/90">
                {detail.publicFields.note}
              </p>
            </section>
          ) : null}

          {/*
            欄位層級可見性（MOC §6.2）。
            訪客視角刻意「看得到欄位存在、看不到內容」，讓權限模型在畫面上是可見的；
            正式版由伺服器依角色過濾，不是靠前端隱藏。
          */}
          <section className="mt-9 border-t border-border pt-8">
            <h2 className="type-card-title flex items-center gap-2 text-lg">
              <IconLock className="size-4 text-muted-foreground" />
              聯絡資訊
            </h2>
            <div className="mt-3 rounded-xl border border-dashed border-border bg-muted/40 p-5">
              <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                {[
                  { label: "公司地址", value: detail.privateFields.address },
                  { label: "聯絡人", value: detail.privateFields.contact },
                  { label: "聯絡電話", value: detail.privateFields.phone },
                  { label: "聯絡 Email", value: detail.privateFields.email },
                ].map((f) => (
                  <div key={f.label}>
                    <dt className="text-xs text-muted-foreground">{f.label}</dt>
                    <dd className="tabular mt-0.5 select-none text-sm text-muted-foreground/70">
                      {f.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
                以上欄位僅負責老師與系辦可見。訪客與學生取得的公開資料中不包含這些欄位，
                伺服器端也不會回傳。
              </p>
            </div>
          </section>

          <div className="mt-10 border-t border-border pt-6">
            <Link
              href="/industry"
              className="press inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <IconArrowLeft className="size-4" />
              回到產學合作列表
            </Link>
          </div>
        </article>

        <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start">
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs font-semibold text-muted-foreground">合作資訊</p>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">合作單位</dt>
                <dd className="mt-0.5 font-medium">{item.company}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">需求部門</dt>
                <dd className="mt-0.5">{item.department}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">負責老師</dt>
                <dd className="mt-0.5">{item.advisorName}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <IconUsersGroup className="size-3.5" />
              連結的組別
            </p>
            {linked.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                尚未有組別連結此合作案。
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {linked.map((g) => (
                  <li key={g.id} className="text-sm">
                    <span className="tabular text-muted-foreground">{g.no}</span>
                    <span className="ml-2">{g.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-border bg-secondary/50 p-5">
            <p className="text-sm font-semibold">學生想參與這個合作案？</p>
            <p className="mt-2 text-sm leading-relaxed text-secondary-foreground/85">
              產學組別由指導老師認領後成立。請先完成分組，並於指導老師意願調查中說明。
            </p>
            <Link
              href="/login"
              className="press mt-4 inline-flex h-9 items-center rounded-full border border-brand/50 px-4 text-sm font-medium text-brand-on-subtle transition-colors hover:bg-brand-subtle"
            >
              登入平台
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}
