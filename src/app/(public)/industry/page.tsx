import Link from "next/link";
import { IconArrowRight, IconLock } from "@tabler/icons-react";
import { PageHeader } from "@/components/public/page-header";
import { Badge } from "@/components/ui/badge";
import { INDUSTRY } from "@/lib/fixtures";

export const metadata = { title: "產學合作" };

export default function IndustryPage() {
  const open = INDUSTRY.filter((i) => i.status === "open");

  return (
    <>
      <PageHeader
        title="產學合作"
        breadcrumb={[{ href: "/industry", label: "產學合作" }]}
        description="由指導老師建立的合作需求。公司名稱、需求部門與專題內容為公開資訊；聯絡人、電話、地址僅負責老師與系辦可見。"
        meta={
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span className="tabular">共 {INDUSTRY.length} 件</span>
            <span aria-hidden>·</span>
            <span className="tabular">尚未指派組別 {open.length} 件</span>
          </div>
        }
      />

      <div className="mx-auto max-w-6xl px-5 py-10 md:py-14">
        {/* 列表只顯示摘要欄位，完整內容進詳情頁（MOC §6.2） */}
        <ul className="space-y-4">
          {INDUSTRY.map((item) => (
            <li key={item.id}>
              <Link
                href={`/industry/${item.id}`}
                className="press group block rounded-xl border border-border bg-card p-5 transition-colors hover:border-brand/45"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
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
                      <time className="tabular text-xs text-muted-foreground">
                        {item.publishedAt}
                      </time>
                    </div>
                    <h2 className="type-card-title mt-2 group-hover:text-primary">
                      {item.title}
                    </h2>
                  </div>
                  <IconArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>

                <dl className="mt-4 grid gap-x-8 gap-y-2 border-t border-border pt-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">合作單位</dt>
                    <dd className="mt-0.5 truncate font-medium">{item.company}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">需求部門</dt>
                    <dd className="mt-0.5 truncate">{item.department}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">負責老師</dt>
                    <dd className="mt-0.5 truncate">{item.advisorName}</dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-8 flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 px-5 py-4 text-sm text-muted-foreground">
          <IconLock className="mt-0.5 size-4 shrink-0" />
          <p className="leading-relaxed">
            合作單位的地址、聯絡人、電話與 Email
            不因合作案公開而自動公開。這些欄位由伺服器依角色過濾，未授權的請求不會取得資料。
          </p>
        </div>
      </div>
    </>
  );
}
