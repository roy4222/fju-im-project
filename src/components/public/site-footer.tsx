import Link from "next/link";

const COLUMNS = [
  {
    title: "內容",
    links: [
      { href: "/news", label: "最新公告" },
      { href: "/rules", label: "專題規則" },
      { href: "/projects", label: "歷屆專題" },
      { href: "/honors", label: "榮譽與競賽" },
    ],
  },
  {
    title: "產學",
    links: [
      { href: "/industry", label: "產學合作列表" },
      { href: "/industry?status=open", label: "尚未指派組別" },
    ],
  },
  {
    title: "使用",
    links: [
      { href: "/login", label: "登入" },
      { href: "/register", label: "註冊" },
      { href: "/dashboard", label: "我的專題事務" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border bg-muted/40">
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="grid gap-8 md:grid-cols-[2fr_1fr_1fr_1fr]">
          <div>
            <p className="text-sm font-semibold">輔仁大學資訊管理學系</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              新北市新莊區中正路 510 號
              <br />
              專題相關事務請洽系辦公室
            </p>
          </div>
          {COLUMNS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <p className="text-xs font-semibold tracking-wide text-muted-foreground">
                {col.title}
              </p>
              <ul className="mt-3 space-y-2">
                {col.links.map((l) => (
                  <li key={l.href + l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-foreground/80 hover:text-foreground hover:underline"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-8 flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 輔仁大學資訊管理學系</p>
          <p>原型畫面，資料為虛構示範內容</p>
        </div>
      </div>
    </footer>
  );
}
