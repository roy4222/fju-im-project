import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IconArrowLeft,
  IconExternalLink,
  IconFileText,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { PageHeader } from "@/components/public/page-header";
import { ImagePlaceholder } from "@/components/public/sections";
import { Badge } from "@/components/ui/badge";
import { PROJECTS, PROJECT_DETAIL } from "@/lib/fixtures";

export function generateStaticParams() {
  return PROJECTS.map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  const p = PROJECTS.find((x) => x.id === id);
  return { title: p?.title ?? "專題作品" };
}

export default async function ProjectDetailPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  const project = PROJECTS.find((p) => p.id === id);
  if (!project) notFound();

  const detail = PROJECT_DETAIL[project.id];
  const others = PROJECTS.filter((p) => p.id !== project.id).slice(0, 3);

  return (
    <>
      <PageHeader
        title={project.title}
        breadcrumb={[{ href: "/projects", label: "歷屆專題" }]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="tabular text-[11px] text-muted-foreground">
              {project.cohort} 屆
            </Badge>
            <Badge variant="outline" className="text-[11px] text-muted-foreground">
              {project.field}
            </Badge>
            {project.award ? (
              <Badge
                variant="outline"
                className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle"
              >
                {project.award}
              </Badge>
            ) : null}
          </div>
        }
      />

      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-10 md:py-14 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <article>
          {/*
            作品主視覺。0715 §9 提醒封面圖不可把人像切一半，
            因此正式版這裡用 object-contain + 留白，而不是 cover 裁切。
          */}
          <ImagePlaceholder
            className="aspect-[16/9] rounded-xl border border-border"
            note="作品主視覺待提供（以完整顯示為原則，不裁切人像）"
          />

          <section className="mt-8">
            <h2 className="type-card-title text-lg">摘要</h2>
            <p className="mt-3 text-[1.0625rem] leading-[1.9] text-foreground/90">
              {detail.abstract}
            </p>
          </section>

          <section className="mt-9 border-t border-border pt-8">
            <h2 className="type-card-title text-lg">使用技術</h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {detail.tech.map((t) => (
                <li key={t}>
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    {t}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-9 border-t border-border pt-8">
            <h2 className="type-card-title text-lg">相關資料</h2>
            <ul className="mt-3 space-y-2.5">
              {detail.videoUrl ? (
                <li>
                  <a
                    href={detail.videoUrl}
                    className="press inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    <IconPlayerPlay className="size-4 text-brand" />
                    三分鐘影片（系上 YouTube）
                    <IconExternalLink className="size-3.5 text-muted-foreground" />
                  </a>
                </li>
              ) : null}
              {detail.hasPoster ? (
                <li>
                  <button
                    type="button"
                    className="press inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    <IconFileText className="size-4 text-primary" />
                    專題海報（PDF）
                  </button>
                </li>
              ) : null}
              {!detail.videoUrl && !detail.hasPoster ? (
                <li className="text-sm text-muted-foreground">此作品目前沒有附加資料。</li>
              ) : null}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              影片不上傳系統，一律以系上 YouTube 或校方雲端連結保存。
            </p>
          </section>

          <div className="mt-10 border-t border-border pt-6">
            <Link
              href="/projects"
              className="press inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <IconArrowLeft className="size-4" />
              回到歷屆專題
            </Link>
          </div>
        </article>

        <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start">
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs font-semibold text-muted-foreground">指導老師</p>
            <p className="mt-1 text-sm font-medium">{detail.advisor}</p>

            <p className="mt-4 text-xs font-semibold text-muted-foreground">組員</p>
            <ul className="mt-1.5 space-y-1">
              {detail.members.map((m) => (
                <li key={m} className="text-sm">
                  {m}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              公開頁面僅顯示姓名，不顯示學號、聯絡方式與照片。
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs font-semibold text-muted-foreground">其他作品</p>
            <ul className="mt-3 space-y-2.5">
              {others.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="group flex items-baseline gap-2 text-sm hover:underline"
                  >
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      {p.cohort}
                    </span>
                    <span className="min-w-0 group-hover:text-primary">{p.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}
