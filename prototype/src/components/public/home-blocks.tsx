import Link from "next/link";
import Image from "next/image";
import {
  IconArrowRight,
  IconBook2,
  IconBriefcase,
  IconClock,
  IconDownload,
  IconHandStop,
  IconKey,
  IconLayoutGrid,
  IconMail,
  IconPencil,
  IconStar,
  IconUpload,
  IconUsers,
  IconAlertTriangle,
} from "@tabler/icons-react";
import type { DueEntry, WorkEntry } from "@/lib/data/catalog";
import type { ViewerRole } from "@/lib/data/viewer";
import { formatDue } from "@/lib/fixtures";

const WORK_ICONS: Record<string, React.ReactNode> = {
  requirement: <IconBriefcase className="size-5" />,
  submission: <IconUpload className="size-5" />,
  signoff: <IconPencil className="size-5" />,
  group: <IconUsers className="size-5" />,
  files: <IconDownload className="size-5" />,
  grading: <IconStar className="size-5" />,
  claim: <IconHandStop className="size-5" />,
  industry: <IconBriefcase className="size-5" />,
  accounts: <IconUsers className="size-5" />,
  overdue: <IconAlertTriangle className="size-5" />,
  workbench: <IconLayoutGrid className="size-5" />,
};

/** 登入後首頁「我的工作」列＋近期截止（規格 §3.4–3.6 的摘要，入口進後台） */
export function WorkStrip({ role, work, due, workbench }: { role: ViewerRole; work: WorkEntry[]; due: DueEntry[]; workbench: { label: string; href: string } }) {
  return (
    <section className="border-b border-border bg-muted/50" aria-label="我的工作">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">我的工作</h2>
            <Link href={workbench.href} className="inline-flex items-center gap-1 text-sm font-semibold text-brand hover:underline">
              進入{workbench.label} <IconArrowRight className="size-4" />
            </Link>
          </div>
          <ul className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-5">
            {work.map((w) => (
              <li key={w.key}>
                <Link href={w.href} className="card-lift flex h-full flex-col gap-2.5 rounded-[10px] border border-border bg-card p-5 hover:border-brand">
                  <span className="text-brand">{WORK_ICONS[w.key]}</span>
                  <span className="text-[17px] font-bold">{w.title}</span>
                  <span className="text-[13px] text-muted-foreground">{w.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-3.5 rounded-[10px] border border-border bg-card px-5.5 py-4.5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">近期截止</h2>
            <Link href={`/dashboard/${role}/affairs`} className="text-[13px] font-semibold text-brand hover:underline">
              全部 →
            </Link>
          </div>
          <ul className="flex flex-col gap-3.5">
            {due.map((d) => (
              <li key={d.id} className="fju-list-item flex flex-col gap-1 py-1.5">
                <Link href={d.href} className="flex items-center gap-3 hover:text-brand">
                  <span className="tabular text-[22px] font-extrabold text-primary">{d.dueAt.slice(5).replace("-", "/")}</span>
                  <span className="text-base font-bold leading-snug">{d.title}</span>
                </Link>
                <span className={`inline-flex items-center gap-1 text-[13px] font-bold ${d.days < 0 ? "text-destructive" : d.days <= 10 ? "text-brand" : "text-muted-foreground"}`}>
                  <IconClock className="size-3.5" />
                  {formatDue(d.dueAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** 頁尾前的三欄快速入口（系網「學生園地／系所簡介／相關連結」） */
export function QuickLinks({ role }: { role: ViewerRole }) {
  const member = role !== "guest";
  const cols = [
    { icon: <IconBook2 className="size-5.5" />, title: "專題規則", links: [["專題課程目的", "/rules#s1"], ["分組與指導老師", "/rules#s4"], ["課程要求", "/rules#s7"], ["評分方式", "/rules#s8"]] },
    member
      ? { icon: <IconKey className="size-5.5" />, title: "我的入口", links: [[role === "teacher" ? "老師工作台" : role === "admin" ? "管理後台" : "我的專題事務", `/dashboard/${role}`], ["檔案下載", "/files"], ["個人資料", "/account"], ["歷屆專題一覽", "/projects"]] }
      : { icon: <IconKey className="size-5.5" />, title: "使用平台", links: [["登入", "/login"], ["註冊", "/register"], ["忘記密碼", "/forgot-password"]] },
    { icon: <IconMail className="size-5.5" />, title: "系辦聯絡", links: [["新莊區中正路 510 號 利瑪竇大樓", "https://www.im.fju.edu.tw/"], ["電話 +886-2-2905-2696", "tel:+886229052696"], ["im@mail.fju.edu.tw", "mailto:im@mail.fju.edu.tw"], ["系網 im.fju.edu.tw", "https://www.im.fju.edu.tw/"]] },
  ];
  return (
    <section className="relative overflow-hidden bg-background" aria-label="快速入口">
      <Image src="/placeholder/building.jpg" alt="" fill sizes="100vw" className="object-cover opacity-10" aria-hidden />
      <div className="absolute inset-0 bg-gradient-to-b from-background via-transparent to-background" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 py-18 md:grid-cols-3">
        {cols.map((c) => (
          <div key={c.title} className="flex flex-col gap-3.5">
            <div className="flex items-center gap-3 rounded-[10px] bg-card px-5 py-4 shadow-[0_2px_10px_rgba(0,51,102,0.08)]">
              <span className="text-brand">{c.icon}</span>
              <span className="text-xl font-bold">{c.title}</span>
            </div>
            <ul className="flex flex-col gap-2 px-2">
              {c.links.map(([label, href]) => (
                <li key={label}>
                  <Link href={href} className="group flex items-center gap-2 text-[15px] transition-colors hover:text-brand">
                    <span className="size-1.5 rounded-full bg-brand transition-transform duration-200 group-hover:scale-150" aria-hidden />
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
