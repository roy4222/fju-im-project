import { IconHistory } from "@tabler/icons-react";
import { PageHeader } from "@/components/public/page-header";
import { Badge } from "@/components/ui/badge";
import { RULES_DOC } from "@/lib/fixtures";

export const metadata = { title: "專題規則" };

/**
 * 專題規則。
 *
 * 0715 會議紀錄 §9 明確要求：「可自行編輯的文件式內容，直接列出、可編輯即可
 * （不做需一直點開的層層結構）」——因此全文平鋪展開，沒有任何折疊選單。
 * 側欄目錄只是跳轉工具，不隱藏內容。
 */
export default function RulesPage() {
  return (
    <>
      <PageHeader
        title={`專題規則 ${RULES_DOC.version}`}
        breadcrumb={[{ href: "/rules", label: "專題規則" }]}
        description="本頁為現行版本全文。規則修訂時，已完成的評分與簽核不受影響。"
        meta={
          <div className="flex flex-wrap items-center gap-3">
            <Badge
              variant="outline"
              className="border-success/30 bg-success-subtle text-[11px] text-success-on-subtle"
            >
              現行版本
            </Badge>
            <span className="tabular text-sm text-muted-foreground">
              最後更新 {RULES_DOC.updatedAt}
            </span>
          </div>
        }
      />

      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-10 md:py-14 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <article>
          {RULES_DOC.sections.map((section, idx) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-28 border-b border-border py-8 first:pt-0 last:border-0"
            >
              <h2 className="type-card-title flex items-baseline gap-3 text-lg">
                <span className="tabular text-sm text-brand">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                {section.heading}
              </h2>

              <div className="mt-3.5 space-y-4">
                {section.paragraphs.map((p, i) => (
                  <p key={i} className="text-[1.0625rem] leading-[1.9] text-foreground/90">
                    {p}
                  </p>
                ))}
              </div>

              {"list" in section && section.list ? (
                <ul className="mt-4 space-y-2.5 rounded-xl border border-border bg-muted/40 p-5">
                  {section.list.map((li, i) => (
                    <li key={i} className="flex gap-2.5 text-[0.9375rem] leading-relaxed">
                      <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                      <span>{li}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </article>

        <aside className="lg:sticky lg:top-28 lg:self-start">
          <nav aria-label="本頁目錄" className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-semibold text-muted-foreground">本頁目錄</p>
            <ol className="mt-3 space-y-1">
              {RULES_DOC.sections.map((s, idx) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                  >
                    <span className="tabular text-xs text-muted-foreground">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    {s.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="mt-4 rounded-xl border border-border bg-card p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <IconHistory className="size-3.5" />
              歷史版本
            </p>
            <ul className="mt-3 space-y-2">
              {RULES_DOC.previousVersions.map((v) => (
                <li key={v.version} className="flex items-baseline justify-between gap-2">
                  <span className="tabular text-sm">{v.version}</span>
                  <span className="tabular text-xs text-muted-foreground">{v.updatedAt}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              歷史版本保留於系統中可供查閱，切換版本不影響既有紀錄。
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
