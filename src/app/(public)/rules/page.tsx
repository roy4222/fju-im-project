import type { Metadata } from "next";
import { IconFileText } from "@tabler/icons-react";
import { PageHead } from "@/components/public/blocks";
import { getRules } from "@/lib/data/catalog";

export const metadata: Metadata = {
  title: "專題規則",
  description: "輔大資管系專題規則：課程目的、修課限制、題目範圍、分組與指導老師、轉組、上課方式、課程要求、評分與獎懲。",
  alternates: { canonical: "/rules" },
  openGraph: { url: "/rules" },
};

/** 專題規則：與舊站九節一致（Roy 2026-09-07），文件式全文直接列出，不做歷史版本。 */
export default async function RulesPage() {
  const doc = await getRules();
  return (
    <>
      <PageHead title="專題規則" description={`現行 ${doc.version} 版（${doc.updatedAt} 生效）。全文直接列出，不需逐層點開。`} crumbs={[{ label: "專題規則" }]} />
      <div className="mx-auto grid max-w-6xl gap-14 px-5 py-10 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-28 lg:self-start">
          <p className="text-[13px] font-bold tracking-wider text-muted-foreground">目錄</p>
          <nav aria-label="規則目錄" className="mt-3 flex flex-col">
            {doc.sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="border-l-[3px] border-border py-2 pl-3.5 text-[15px] hover:border-brand hover:text-brand">
                {s.heading}
              </a>
            ))}
          </nav>
          <div className="mt-5 flex flex-col gap-2 rounded-[10px] bg-secondary p-4.5 text-secondary-foreground">
            <p className="font-bold">版本</p>
            <p className="text-sm text-muted-foreground">{doc.version}（{doc.updatedAt} 生效）・只顯示現行版本</p>
            {doc.attachments.map((a) => (
              <a key={a.name} href="#" className="flex items-center gap-2 text-sm font-semibold text-primary hover:text-brand">
                <IconFileText className="size-4" />
                {a.name}
                <span className="text-xs font-normal text-muted-foreground">{a.size}</span>
              </a>
            ))}
          </div>
        </aside>
        <article className="flex flex-col gap-9">
          {doc.sections.map((s) => (
            <section key={s.id} id={s.id} className="flex scroll-mt-28 flex-col gap-3">
              <h2 className="border-b-2 border-border pb-2 text-[22px] font-bold text-primary">{s.heading}</h2>
              {s.paragraphs?.map((p, i) => (
                <p key={i} className="text-base leading-loose">{p}</p>
              ))}
              {s.list ? (
                <ol className="flex list-decimal flex-col gap-1.5 pl-6 text-base leading-loose">
                  {s.list.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ol>
              ) : null}
              {s.notes ? (
                <ul className="mt-1 flex flex-col gap-1 rounded-[10px] bg-muted/60 p-4 text-[15px] leading-relaxed text-muted-foreground">
                  {s.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </article>
      </div>
    </>
  );
}
