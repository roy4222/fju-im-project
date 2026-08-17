import { IconCalendarEvent, IconExternalLink } from "@tabler/icons-react";
import { PageHeader } from "@/components/public/page-header";
import { ImagePlaceholder } from "@/components/public/sections";
import { Badge } from "@/components/ui/badge";
import { COMPETITIONS, daysUntil, formatDue } from "@/lib/fixtures";

export const metadata = { title: "競賽資訊" };

const STATUS: Record<
  string,
  { label: string; className: string }
> = {
  open: {
    label: "開放報名",
    className: "border-brand/30 bg-brand-subtle text-brand-on-subtle",
  },
  closed: {
    label: "已結束",
    className: "text-muted-foreground",
  },
  result: {
    label: "已公布結果",
    className: "border-success/30 bg-success-subtle text-success-on-subtle",
  },
};

/** 0715 會議紀錄 §9：競賽資訊比照公告卡片。 */
export default function CompetitionsPage() {
  const open = COMPETITIONS.filter((c) => c.status === "open");

  return (
    <>
      <PageHeader
        title="競賽資訊"
        breadcrumb={[{ href: "/competitions", label: "競賽資訊" }]}
        description="系上彙整的競賽資訊。系上不代為報名，各組需自行於主辦單位系統完成程序。"
        meta={
          <p className="tabular text-sm text-muted-foreground">
            共 {COMPETITIONS.length} 筆，其中 {open.length} 筆開放報名
          </p>
        }
      />

      <div className="mx-auto max-w-6xl px-5 py-10 md:py-14">
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {COMPETITIONS.map((c) => {
            const s = STATUS[c.status];
            const d = daysUntil(c.deadline);
            return (
              <li key={c.id}>
                <article className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card">
                  <ImagePlaceholder className="aspect-[16/10]" note="競賽宣傳圖待提供" />
                  <div className="flex flex-1 flex-col p-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={`text-[11px] ${s.className}`}>
                        {s.label}
                      </Badge>
                      {c.status === "open" ? (
                        <span
                          className={`tabular ml-auto text-xs font-semibold ${
                            d <= 30 ? "text-brand-on-subtle" : "text-muted-foreground"
                          }`}
                        >
                          {formatDue(c.deadline)}
                        </span>
                      ) : null}
                    </div>

                    <h2 className="type-card-title mt-2.5">{c.title}</h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {c.summary}
                    </p>

                    <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs">
                      <div className="flex gap-2">
                        <dt className="w-16 shrink-0 text-muted-foreground">主辦單位</dt>
                        <dd>{c.organizer}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-16 shrink-0 text-muted-foreground">報名截止</dt>
                        <dd className="tabular">{c.deadline}</dd>
                      </div>
                      {c.eventDate ? (
                        <div className="flex gap-2">
                          <dt className="w-16 shrink-0 text-muted-foreground">活動日期</dt>
                          <dd className="tabular flex items-center gap-1">
                            <IconCalendarEvent className="size-3.5 text-muted-foreground" />
                            {c.eventDate}
                          </dd>
                        </div>
                      ) : null}
                    </dl>

                    {c.status === "open" ? (
                      <a
                        href="#"
                        className="press mt-4 inline-flex h-9 items-center gap-1.5 self-start rounded-full border border-brand/50 px-4 text-xs font-medium text-brand-on-subtle transition-colors hover:bg-brand-subtle"
                      >
                        前往主辦單位報名
                        <IconExternalLink className="size-3.5" />
                      </a>
                    ) : null}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
