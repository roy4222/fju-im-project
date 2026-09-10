import { notFound } from "next/navigation";
import Link from "next/link";
import { IconUserPlus, IconUsers } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, Panel } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { TrendArea } from "@/components/dashboard/rc-charts";
import { isValidRole } from "@/lib/nav-config";
import { ACCOUNTS } from "@/lib/fixtures";
import { AccountsTable, ImportRosterDialog } from "./accounts-table";

export default async function AccountsPage({ params, searchParams }: PageProps<"/dashboard/[role]/accounts">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role) || role !== "admin") notFound();
  const pending = ACCOUNTS.filter((a) => a.status === "pending").length;
  const active = ACCOUNTS.filter((a) => a.status === "active").length;
  const disabled = ACCOUNTS.filter((a) => a.status === "disabled").length;
  const status = typeof sp.status === "string" ? sp.status : undefined;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="帳號管理" description="系統不存在可被查看的密碼；只能重設一次性臨時密碼。" actions={<><button type="button" className="btn-fju h-10 px-4 text-sm"><IconUserPlus className="size-4" /> 新增帳號</button></>} />
      {/* Roy 2026-09-10 選畫布 B：三個環（已核准／待審核／已停用）＋註冊趨勢，表在下 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <RingTile label="已核准" value={active} hint={`名單命中自動 ${ACCOUNTS.filter((a) => a.approvedBy === "名單自動").length}・人工 ${ACCOUNTS.filter((a) => a.status === "active" && a.approvedBy !== "名單自動").length}`} pct={(active / ACCOUNTS.length) * 100} color="var(--primary)" />
        <RingTile label="待審核" value={pending} hint="最久 3 天・目標 2 天內" pct={(pending / ACCOUNTS.length) * 100} color="var(--brand)" href={`/dashboard/${role}/accounts?status=pending`} hot />
        <RingTile label="已停用" value={disabled} hint="休學 1・重複 1" pct={(disabled / ACCOUNTS.length) * 100} color="var(--border)" />
      </div>
      <Panel title="註冊與審核趨勢" icon={<IconUsers />} description="8/13 匯入名單起・每日新帳號" action={<ImportRosterDialog />}>
        <div className="grid gap-4 px-3 pb-3 md:grid-cols-[minmax(0,1fr)_14rem]">
          <TrendArea height={150} color="var(--primary)" data={[["08/13", 12], ["08/14", 30], ["08/15", 48], ["08/16", 22], ["08/17", 9], ["08/18", 5], ["08/19", 4]].map(([label, value]) => ({ label: String(label), value: Number(value) }))} />
          <dl className="flex flex-col justify-center gap-2 px-2 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">自動核准</dt><dd className="tabular font-bold">125</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">人工核准</dt><dd className="tabular font-bold">94</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">退回</dt><dd className="tabular font-bold">3</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">平均等待</dt><dd className="tabular font-bold">0.8 天</dd></div>
          </dl>
        </div>
      </Panel>
      <Panel title="全部帳號" icon={<IconUsers />} description="可搜尋、排序、篩選、勾選匯出與批次停用" bodyClassName="p-4">
        <AccountsTable accounts={ACCOUNTS} initialStatus={status} />
      </Panel>
      <p className="text-xs text-muted-foreground">永久刪除為獨立高風險動作：需影響預覽、再次輸入確認文字並產生紀錄。<span className={buttonVariants({ variant: "link", size: "sm" })}>了解更多</span></p>
    </div>
  );
}

function RingTile({ label, value, hint, pct, color, href, hot }: { label: string; value: number; hint: string; pct: number; color: string; href?: string; hot?: boolean }) {
  const body = (
    <>
      <Ring value={pct} size={72} stroke={9} color={color}><span className="tabular text-sm font-extrabold">{Math.round(pct)}%</span></Ring>
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-muted-foreground">{label}</p>
        <p className={`tabular text-[28px] font-extrabold leading-none ${hot ? "text-brand" : ""}`}>{value}</p>
        <p className="mt-1 truncate text-[12px] text-muted-foreground">{hint}</p>
      </div>
    </>
  );
  const cls = `dash-card dash-card-hover flex items-center gap-4 px-5 py-4 ${hot ? "border-brand" : ""}`;
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}
