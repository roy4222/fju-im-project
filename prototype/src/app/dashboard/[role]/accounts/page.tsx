import { notFound } from "next/navigation";
import { IconUserCheck, IconUserOff, IconUserPlus, IconUsers } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, Panel, StatTile } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
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
      <PageTitle title="帳號管理" description="系統不存在可被查看的密碼；只能重設一次性臨時密碼。" actions={<><ImportRosterDialog /><button type="button" className="btn-fju h-10 px-4 text-sm"><IconUserPlus className="size-4" /> 新增帳號</button></>} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="待審核" icon={<IconUserCheck />} value={pending} unit="筆" tone="warning" href={`/dashboard/${role}/accounts?status=pending`} />
        <StatTile label="已核准" icon={<IconUsers />} value={active} unit="筆" tone="success" chart={<Ring value={(active / ACCOUNTS.length) * 100} size={44} stroke={5} color="var(--success)" />} />
        <StatTile label="已停用" icon={<IconUserOff />} value={disabled} unit="筆" />
        <StatTile label="名單版本" icon={<IconUsers />} value="v3" hint="52 筆・08-13 匯入" />
      </div>
      <Panel title="全部帳號" icon={<IconUsers />} description="可搜尋、排序、篩選、勾選匯出與批次停用" bodyClassName="p-4">
        <AccountsTable accounts={ACCOUNTS} initialStatus={status} />
      </Panel>
      <p className="text-xs text-muted-foreground">永久刪除為獨立高風險動作：需影響預覽、再次輸入確認文字並產生紀錄。<span className={buttonVariants({ variant: "link", size: "sm" })}>了解更多</span></p>
    </div>
  );
}
