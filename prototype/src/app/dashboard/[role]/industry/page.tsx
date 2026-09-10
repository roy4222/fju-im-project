import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowRight, IconBriefcase, IconBuilding, IconEyeOff, IconLink } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, Panel, Pill, StatTile } from "@/components/dashboard/primitives";
import { Ring } from "@/components/dashboard/charts";
import { IndustryFormDialog } from "@/components/dashboard/industry-form";
import { isValidRole } from "@/lib/nav-config";
import { CURRENT_USERS, GROUPS, INDUSTRY } from "@/lib/fixtures";

export default async function IndustryPage({ params }: PageProps<"/dashboard/[role]/industry">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  const me = CURRENT_USERS[role];
  const mine = role === "teacher" ? INDUSTRY.filter((i) => i.advisorName === me.name) : INDUSTRY;
  const publicCount = INDUSTRY.filter((i) => i.publishStatus === "public").length;
  const open = INDUSTRY.filter((i) => i.status === "open").length;

  if (role === "student") {
    return (
      <div className="flex flex-col gap-5">
        <PageTitle title="產學合作" description="老師建立的合作案；產學組可連結合作案，公司與部門自動帶入。" actions={<Link href="/industry" className={buttonVariants({ variant: "outline", size: "lg", className: "press rounded-lg" })}>前台列表 <IconArrowRight /></Link>} />
        <div className="grid gap-4 md:grid-cols-2">
          {INDUSTRY.filter((i) => i.publishStatus === "public").map((i) => (
            <Link key={i.id} href={`/industry/${i.id}`} className="card-lift flex items-center gap-4 rounded-xl border border-border bg-card p-5">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-subtle text-brand-on-subtle"><IconBuilding className="size-5" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate font-bold">{i.company}</span><span className="block truncate text-sm text-muted-foreground">{i.title}</span></span>
              {i.status === "claimed" ? <Pill tone="info">已有 {i.linkedGroups} 組</Pill> : <Pill tone="brand">尚未指派</Pill>}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title={role === "teacher" ? "我的合作案" : "產學合作管理"} description={role === "teacher" ? "建立、編輯、下架自己的合作案。" : "管理全部合作案與組別連結。"} actions={<IndustryFormDialog />} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label={role === "teacher" ? "我的合作案" : "全部合作案"} icon={<IconBriefcase />} value={mine.length} unit="件" hint={`${mine.filter((i) => i.publishStatus === "public").length} 件公開`} chart={<Ring value={(publicCount / Math.max(INDUSTRY.length, 1)) * 100} size={44} stroke={5} />} />
        <StatTile label="尚未指派組別" icon={<IconLink />} value={open} unit="件" tone={open ? "brand" : "default"} />
        <StatTile label="已連結組別" icon={<IconLink />} value={INDUSTRY.reduce((a, i) => a + i.linkedGroups, 0)} unit="組" tone="success" />
      </div>
      <Panel title="合作案" icon={<IconBriefcase />} description="聯絡資料只有負責老師與系辦看得到">
        <ul className="divide-y divide-border">
          {mine.map((i) => {
            const linked = GROUPS.filter((g) => g.industryId === i.id);
            return (
              <li key={i.id} className="grid items-center gap-3 px-5 py-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Pill tone={i.publishStatus === "public" ? "success" : i.publishStatus === "draft" ? "info" : "default"}>{i.publishStatus === "public" ? "公開" : i.publishStatus === "draft" ? "草稿" : "已下架"}</Pill>
                    {i.status === "claimed" ? <Pill tone="info">已有 {i.linkedGroups} 組</Pill> : <Pill tone="brand">尚未指派</Pill>}
                    <span className="tabular text-xs text-muted-foreground">{i.publishedAt}</span>
                  </div>
                  <Link href={`/industry/${i.id}`} className="link-ink mt-1 block truncate text-[15px] font-bold">{i.company}</Link>
                  <p className="truncate text-sm text-muted-foreground">{i.department}・{i.title}</p>
                </div>
                <div className="text-xs text-muted-foreground">
                  {role === "admin" ? <span className="block font-semibold text-foreground">{i.advisorName} 老師</span> : null}
                  {linked.length ? linked.map((g) => <span key={g.id} className="block truncate">{g.no}・{g.title.replace(/（產學：.*）/, "")}</span>) : <span className="inline-flex items-center gap-1"><IconEyeOff className="size-3.5" />尚無組別連結</span>}
                </div>
                <div className="flex gap-2 md:justify-self-end">
                  <IndustryFormDialog mode="edit" initial={{ company: i.company, department: i.department, title: i.title }} />
                  <button type="button" className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })}>{i.publishStatus === "public" ? "下架" : "公開"}</button>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
