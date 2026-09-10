import { notFound } from "next/navigation";
import { IconHistory } from "@tabler/icons-react";
import { PageTitle, Panel } from "@/components/dashboard/primitives";
import { isValidRole } from "@/lib/nav-config";
import { AUDIT_EVENTS } from "@/lib/fixtures";
import { AuditList } from "./audit-list";

/** 操作紀錄（規格 §12 AuditEvent）：append-only；actor、target、reason。一頁一個焦點＝清單，數字放標題下一行。 */
export default async function AuditPage({ params, searchParams }: PageProps<"/dashboard/[role]/audit">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role) || role !== "admin") notFound();
  const admin = AUDIT_EVENTS.filter((e) => e.role === "admin").length;
  const withReason = AUDIT_EVENTS.filter((e) => e.reason).length;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="操作紀錄" description={`近 7 天 ${AUDIT_EVENTS.length} 筆・管理員操作 ${admin} 筆・附理由 ${withReason} 筆（重開、更正、例外都必填）。誰、何時、對哪個對象、做了什麼、為什麼；不可修改。`} />
      <Panel title="事件" icon={<IconHistory />}>
        <AuditList events={AUDIT_EVENTS} initial={typeof sp.role === "string" ? sp.role : "all"} />
      </Panel>
    </div>
  );
}
