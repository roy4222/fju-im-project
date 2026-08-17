"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconExternalLink, IconMenu2 } from "@tabler/icons-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV = [
  { href: "/news", label: "公告" },
  { href: "/rules", label: "專題規則" },
  { href: "/industry", label: "產學合作" },
  { href: "/projects", label: "歷屆專題" },
  { href: "/honors", label: "榮譽與競賽" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // apple-design §12：不要固定掛一條 1px 分隔線；只在內容真的捲到 chrome 底下才浮現
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="sticky top-0 z-50">
      {/* 校級 utility bar：讓訪客知道這是系網的子站 */}
      <div className="hidden bg-primary text-primary-foreground md:block dark:bg-card dark:text-muted-foreground">
        <div className="mx-auto flex h-8 max-w-6xl items-center justify-between px-5 text-xs">
          <nav className="flex items-center gap-4" aria-label="校級連結">
            <a
              href="https://www.fju.edu.tw/"
              className="inline-flex items-center gap-1 opacity-85 transition-opacity hover:opacity-100"
            >
              輔仁大學 <IconExternalLink className="size-3" />
            </a>
            <span className="opacity-30">|</span>
            <a
              href="https://www.im.fju.edu.tw/"
              className="inline-flex items-center gap-1 opacity-85 transition-opacity hover:opacity-100"
            >
              資訊管理學系 <IconExternalLink className="size-3" />
            </a>
          </nav>
          <div className="flex items-center gap-3 opacity-85">
            <span className="tabular">114 學年度</span>
            <span className="opacity-30">|</span>
            <a href="#" className="hover:underline">
              系辦聯絡
            </a>
          </div>
        </div>
      </div>

      <div
        className={`transition-all duration-200 ${
          scrolled
            ? "border-b border-border bg-background/85 backdrop-blur-md"
            : "border-b border-transparent bg-background"
        }`}
      >
        <div className="mx-auto flex h-[4.5rem] max-w-6xl items-center gap-5 px-5">
          <Link href="/" className="press flex items-center gap-3">
            <span
              aria-hidden
              className="type-brand flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-[11px] font-bold leading-none text-primary-foreground"
            >
              IM
            </span>
            <span className="flex flex-col leading-tight">
              <span className="type-brand text-[1.0625rem] font-semibold">
                資管系專題管理平台
              </span>
              <span className="type-eyebrow text-muted-foreground">
                FJU Information Management
              </span>
            </span>
          </Link>

          <nav className="ml-auto hidden items-center gap-0.5 lg:flex" aria-label="主要導覽">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-2 text-sm font-medium text-foreground/75 transition-colors hover:bg-accent hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1.5 lg:ml-2">
            <ThemeToggle size="icon-lg" />
            <Link
              href="/login"
              className={buttonVariants({
                size: "lg",
                className: "press h-10 rounded-full px-5",
              })}
            >
              登入
            </Link>

            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    className="lg:hidden"
                    aria-label="開啟選單"
                  >
                    <IconMenu2 className="size-5" />
                  </Button>
                }
              />
              <SheetContent side="right" className="w-72">
                <SheetTitle className="px-4 pt-4 text-base">選單</SheetTitle>
                <nav className="mt-2 flex flex-col p-2" aria-label="主要導覽">
                  {NAV.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className="rounded-lg px-3 py-3 text-sm font-medium transition-colors hover:bg-accent"
                    >
                      {item.label}
                    </Link>
                  ))}
                  <Link
                    href="/register"
                    onClick={() => setOpen(false)}
                    className="mt-2 rounded-lg px-3 py-3 text-sm font-medium text-primary transition-colors hover:bg-accent"
                  >
                    註冊帳號
                  </Link>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  );
}
