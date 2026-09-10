import { notFound } from "next/navigation";
import Link from "next/link";
import { IconUsers } from "@tabler/icons-react";
import { PageTitle, Panel } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { NewAccountDialog } from "@/components/dashboard/new-account-dialog";
import { isValidRole } from "@/lib/nav-config";
import { ACCOUNTS, pendingAccounts } from "@/lib/fixtures";
import { AccountsTable, FilterTag, ImportRosterDialog } from "./accounts-table";

const STATUS_LABEL: Record<string, string> = { pending: "待審核", active: "已核准", disabled: "已停用" };

/**
 * 帳號管理（Codex 09-10 A-04／A-05）：一列標題＋一個主要動作；三個環（Roy 選畫布 B）；焦點＝待審核清單。
 * 數字都從 ACCOUNTS 算：已核准＝名單自動＋人工（只算 active）。註冊趨勢圖的數字對不上 fixture，先拿掉。
 */
export default async function AccountsPage({ params, searchParams }: PageProps<"/dashboard/[role]/accounts">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role) || role !== "admin") notFound();
  const base = `/dashboard/${role}/accounts`;
  const pending = pendingAccounts().length;
  const active = ACCOUNTS.filter((a) => a.status === "active");
  const auto = active.filter((a) => a.approvedBy === "名單自動").length;
  const manual = active.length - auto;
  const disabled = ACCOUNTS.filter((a) => a.status === "disabled").length;
  const status = typeof sp.status === "string" && sp.status in STATUS_LABEL ? sp.status : undefined;
  const filtered = status ? ACCOUNTS.filter((a) => a.status === status).length : ACCOUNTS.length;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="帳號管理" description={`${ACCOUNTS.length} 筆。系統不存可查看的密碼，只能重設一次性臨時密碼。`} actions={<NewAccountDialog />} />
      <div className="grid gap-4 sm:grid-cols-3">
        <RingTile label="已核准" value={active.length} hint={`名單自動 ${auto}・人工 ${manual}`} pct={(active.length / ACCOUNTS.length) * 100} color="var(--primary)" href={`${base}?status=active`} active={status === "active"} />
        <RingTile label="待審核" value={pending} hint="名單未命中或外部 Email" pct={(pending / ACCOUNTS.length) * 100} color="var(--brand)" href={`${base}?status=pending`} hot active={status === "pending"} />
        <RingTile label="已停用" value={disabled} hint="停用不是刪除，可還原" pct={(disabled / ACCOUNTS.length) * 100} color="var(--border)" href={`${base}?status=disabled`} active={status === "disabled"} />
      </div>
      <Panel title={status ? `${STATUS_LABEL[status]}帳號` : "全部帳號"} icon={<IconUsers />} description={status ? undefined : "搜尋、篩選、勾選批次停用"} action={<ImportRosterDialog />} bodyClassName="p-4">
        {status ? <div className="mb-3"><FilterTag label={STATUS_LABEL[status]} count={filtered} total={ACCOUNTS.length} clearHref={base} /></div> : null}
        <AccountsTable accounts={ACCOUNTS} initialStatus={status} />
      </Panel>
      <p className="text-xs text-muted-foreground">永久刪除為獨立高風險動作：需影響預覽、再次輸入確認文字並產生紀錄；原型尚未提供。</p>
    </div>
  );
}

function RingTile({ label, value, hint, pct, color, href, hot, active }: { label: string; value: number; hint: string; pct: number; color: string; href: string; hot?: boolean; active?: boolean }) {
  return (
    <Link href={href} aria-current={active ? "true" : undefined} className={`dash-card dash-card-hover flex items-center gap-4 px-5 py-4 ${active ? "border-brand ring-1 ring-brand" : ""}`}>
      <Ring value={pct} size={64} stroke={8} color={color}><span className="tabular text-xs font-extrabold">{Math.round(pct)}%</span></Ring>
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-muted-foreground">{label}</p>
        <p className={`tabular text-[28px] font-extrabold leading-none ${hot ? "text-brand" : ""}`}>{value}<span className="ml-1 text-[12px] font-medium text-muted-foreground">／{ACCOUNTS.length}</span></p>
        <p className="mt-1 truncate text-[12px] text-muted-foreground">{hint}</p>
      </div>
    </Link>
  );
}
