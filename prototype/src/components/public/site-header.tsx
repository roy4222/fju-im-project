"use client";

import Link from "next/link";
import Image from "next/image";
import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { IconChevronDown, IconLayoutDashboard, IconLogout, IconMenu2, IconUserCircle } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ROLE_LABEL, type ViewerRole } from "@/lib/data/roles";

type NavItem = { label: string; href: string; children?: { label: string; href: string }[]; match: (p: string) => boolean };

/** 訪客與登入後的導覽不同（規格 v1.0.4 §9.1；7/22 §6.2） */
function navFor(role: ViewerRole): NavItem[] {
  const news: NavItem = {
    label: "最新公告",
    href: "/news",
    children: [
      { label: "公告列表", href: "/news" },
      { label: "競賽資訊", href: "/competitions" },
    ],
    match: (p) => p.startsWith("/news") || p.startsWith("/competitions"),
  };
  const rules: NavItem = { label: "專題規則", href: "/rules", match: (p) => p.startsWith("/rules") };
  if (role === "guest") {
    return [
      news,
      rules,
      { label: "優秀專題", href: "/projects/featured", match: (p) => p.startsWith("/projects") },
      { label: "榮譽榜", href: "/honors", match: (p) => p.startsWith("/honors") },
    ];
  }
  return [
    news,
    rules,
    {
      label: "歷屆專題",
      href: "/projects",
      children: [
        { label: "歷屆專題一覽", href: "/projects" },
        { label: "優秀專題", href: "/projects/featured" },
        { label: "榮譽榜", href: "/honors" },
      ],
      match: (p) => p.startsWith("/projects") || p.startsWith("/honors"),
    },
    { label: "產學合作", href: "/industry", match: (p) => p.startsWith("/industry") },
    { label: "檔案下載", href: "/files", match: (p) => p.startsWith("/files") },
  ];
}

/**
 * 前台導覽列（Roy 2026-09-08）：
 * - 容器吃滿寬度（最寬 1600px），左 logo、選單靠右，登入後選單變多也不擠。
 * - 沒有深淺主題切換：學校網站固定白底。
 * - 右上角頭像是下拉選單（個人資料、後台、登出），不是直接進個人資料。
 */
export function SiteHeader({
  role,
  userName,
  workbench,
}: {
  role: ViewerRole;
  userName: string | null;
  workbench: { label: string; href: string };
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const nav = navFor(role);
  const logoutForm = useRef<HTMLFormElement>(null);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background">
      <div className="mx-auto flex h-20 w-full max-w-[1600px] items-center gap-6 px-5 md:px-8 xl:px-12">
        <Link href="/" className="flex shrink-0 items-center gap-3.5">
          <Image src="/brand/fju-im-logo.png" alt="輔仁大學資訊管理學系" width={763} height={187} priority className="h-11 w-auto" />
          <span aria-hidden className="hidden h-8 w-px bg-border sm:block" />
          <span className="hidden text-[17px] font-bold sm:block">專題管理平台</span>
        </Link>

        {/* 桌機導覽：靠右；hover 或鍵盤 focus 展開下拉（系網樣式：白底、上緣 3px 橘線） */}
        <nav className="ml-auto hidden items-center gap-6 xl:gap-8 lg:flex" aria-label="主要導覽">
          {nav.map((item) => {
            const active = item.match(pathname);
            return (
              <div key={item.label} className="group relative">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`nav-ink inline-flex items-center gap-1 py-7 text-[16px] font-semibold whitespace-nowrap transition-colors duration-300 hover:text-brand ${active ? "text-brand" : "text-foreground"}`}
                >
                  {item.label}
                  {item.children ? <IconChevronDown className="size-3.5" aria-hidden /> : null}
                </Link>
                {item.children ? (
                  <div className="nav-dropdown invisible absolute top-full left-0 z-20 flex min-w-60 flex-col border-t-[3px] border-brand bg-popover opacity-0 shadow-[0_6px_18px_rgba(0,0,0,0.12)] group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                    {item.children.map((c) => (
                      <Link key={c.href} href={c.href} className="border-b border-border px-4.5 py-3.5 text-[15px] transition-[background-color,color,padding-left] duration-200 hover:bg-brand-subtle hover:pl-6 hover:text-brand-on-subtle">
                        {c.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-3 lg:ml-4 xl:ml-6">
          {role === "guest" ? (
            <Link href="/login" className="btn-fju hidden h-10.5 px-5.5 text-[15px] sm:inline-flex">
              登入
            </Link>
          ) : (
            <>
              <Link href={workbench.href} className="btn-fju hidden h-10.5 px-5 text-[15px] whitespace-nowrap sm:inline-flex">
                {workbench.label}
              </Link>
              <form ref={logoutForm} method="post" action="/api/proto-role" className="hidden">
                <input type="hidden" name="role" value="guest" />
                <input type="hidden" name="returnTo" value="/" />
              </form>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button type="button" className="hidden items-center gap-2 rounded-md py-1 pr-1.5 pl-1 transition-colors hover:bg-accent sm:flex" aria-label="帳號選單">
                      <span className="inline-flex size-8.5 items-center justify-center rounded-full bg-brand-subtle font-bold text-brand-on-subtle">{userName?.slice(0, 1)}</span>
                      <span className="hidden flex-col items-start leading-tight md:flex">
                        <span className="text-sm font-bold whitespace-nowrap">{userName}</span>
                        <span className="text-xs text-muted-foreground">{ROLE_LABEL[role]}</span>
                      </span>
                      <IconChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
                    </button>
                  }
                />
                <DropdownMenuContent align="end" className="w-52 p-1.5">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">{userName}・{ROLE_LABEL[role]}</DropdownMenuLabel>
                    <DropdownMenuItem className="h-9 px-2.5 text-[15px]" render={<Link href="/account" />}>
                      <IconUserCircle /> 個人資料
                    </DropdownMenuItem>
                    <DropdownMenuItem className="h-9 px-2.5 text-[15px]" render={<Link href={workbench.href} />}>
                      <IconLayoutDashboard /> {workbench.label}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="h-9 px-2.5 text-[15px]" onClick={() => logoutForm.current?.requestSubmit()}>
                    <IconLogout /> 登出
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger render={<Button variant="ghost" size="icon-lg" className="lg:hidden" aria-label="開啟選單"><IconMenu2 className="size-5" /></Button>} />
            <SheetContent side="right" className="w-80">
              <SheetTitle className="px-4 pt-4 text-base">選單</SheetTitle>
              <nav className="mt-2 flex flex-col p-2" aria-label="主要導覽">
                {nav.flatMap((item) => [
                  <Link key={item.href} href={item.href} onClick={() => setOpen(false)} className="rounded-lg px-3 py-3 text-[15px] font-semibold hover:bg-accent">
                    {item.label}
                  </Link>,
                  ...(item.children ?? []).map((c) => (
                    <Link key={c.href + c.label} href={c.href} onClick={() => setOpen(false)} className="rounded-lg py-2.5 pr-3 pl-7 text-sm text-muted-foreground hover:bg-accent">
                      {c.label}
                    </Link>
                  )),
                ])}
                {role !== "guest" ? (
                  <>
                    <Link href={workbench.href} onClick={() => setOpen(false)} className="mt-2 rounded-lg px-3 py-3 text-[15px] font-semibold text-brand">
                      {workbench.label}
                    </Link>
                    <Link href="/account" onClick={() => setOpen(false)} className="rounded-lg px-3 py-3 text-[15px]">
                      個人資料
                    </Link>
                    <button type="button" onClick={() => logoutForm.current?.requestSubmit()} className="rounded-lg px-3 py-3 text-left text-[15px] text-muted-foreground">
                      登出
                    </button>
                  </>
                ) : (
                  <>
                    <Link href="/login" onClick={() => setOpen(false)} className="mt-2 rounded-lg px-3 py-3 text-[15px] font-semibold text-brand">
                      登入
                    </Link>
                    <Link href="/register" onClick={() => setOpen(false)} className="rounded-lg px-3 py-3 text-[15px]">
                      註冊
                    </Link>
                  </>
                )}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
