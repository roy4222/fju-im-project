import Link from "next/link";
import type { ViewerRole } from "@/lib/data/viewer";

export function SiteFooter({ role }: { role: ViewerRole }) {
  const member = role !== "guest";
  const columns = [
    {
      title: "內容",
      links: [
        { href: "/news", label: "最新公告" },
        { href: "/competitions", label: "競賽資訊" },
        { href: "/rules", label: "專題規則" },
        { href: "/projects/featured", label: "優秀專題" },
        { href: "/honors", label: "榮譽榜" },
      ],
    },
    {
      title: member ? "登入後" : "本系學生與老師",
      links: member
        ? [
            { href: "/projects", label: "歷屆專題一覽" },
            { href: "/industry", label: "產學合作" },
            { href: "/files", label: "檔案下載" },
          ]
        : [
            { href: "/login", label: "登入後可看歷屆專題一覽" },
            { href: "/login", label: "登入後可看產學合作" },
            { href: "/login", label: "登入後可下載檔案" },
          ],
    },
    {
      title: "使用",
      links: member
        ? [
            { href: "/account", label: "個人資料" },
            { href: `/dashboard/${role}`, label: role === "teacher" ? "老師工作台" : role === "admin" ? "管理後台" : "我的專題事務" },
          ]
        : [
            { href: "/login", label: "登入" },
            { href: "/register", label: "註冊" },
            { href: "/forgot-password", label: "忘記密碼" },
          ],
    },
  ];
  return (
    <footer className="bg-primary text-primary-foreground dark:bg-card dark:text-foreground">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.3fr_1fr_1fr_1fr]">
        <div>
          <p className="text-lg font-bold">輔仁大學資訊管理學系</p>
          <p className="mt-3 text-[13px] leading-loose opacity-85">
            242 新北市新莊區中正路 510 號 利瑪竇大樓
            <br />
            電話 +886-2-2905-2696
            <br />
            專題相關事務請洽系辦公室
          </p>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="text-sm font-bold">{col.title}</p>
            <ul className="mt-3 space-y-2.5">
              {col.links.map((l) => (
                <li key={l.href + l.label}>
                  <Link href={l.href} className="text-sm opacity-85 hover:underline hover:opacity-100">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-white/15 dark:border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-4 text-xs opacity-75 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 輔仁大學資訊管理學系</p>
          <p>原型畫面，照片暫用系網素材，資料為虛構示範</p>
        </div>
      </div>
    </footer>
  );
}
