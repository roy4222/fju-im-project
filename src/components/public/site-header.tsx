"use client";

import Link from "next/link";
import { useState } from "react";
import { IconExternalLink, IconMenu2 } from "@tabler/icons-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
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

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {/* 校級 utility bar：讓訪客知道自己在系網的子站，不是另一個獨立網站 */}
      {/* 深色模式下 primary 是亮藍，整條會太跳，退成卡片色 */}
      <div className="hidden bg-primary text-primary-foreground md:block dark:bg-card dark:text-muted-foreground">
        <div className="mx-auto flex h-8 max-w-7xl items-center justify-between px-4 text-xs">
          <nav className="flex items-center gap-4" aria-label="校級連結">
            <a
              href="https://www.fju.edu.tw/"
              className="inline-flex items-center gap-1 opacity-90 transition-opacity hover:opacity-100"
            >
              輔仁大學 <IconExternalLink className="size-3" />
            </a>
            <span className="opacity-40">|</span>
            <a
              href="https://www.im.fju.edu.tw/"
              className="inline-flex items-center gap-1 opacity-90 transition-opacity hover:opacity-100"
            >
              資訊管理學系 <IconExternalLink className="size-3" />
            </a>
            <span className="opacity-40">|</span>
            <span className="font-medium">專題管理平台</span>
          </nav>
          <div className="flex items-center gap-3 opacity-90">
            <span>114 學年度</span>
            <span className="opacity-40">|</span>
            <a href="#" className="hover:underline">
              系辦聯絡
            </a>
          </div>
        </div>
      </div>

      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-bold leading-tight text-primary-foreground"
          >
            FJU
            <br />
            IM
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-base font-semibold tracking-tight">
              資管系專題管理平台
            </span>
            <span className="text-xs text-muted-foreground">
              Department of Information Management, FJU
            </span>
          </span>
        </Link>

        <nav className="ml-auto hidden items-center lg:flex" aria-label="主要導覽">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          <ThemeToggle />
          <Separator orientation="vertical" className="mx-1 hidden h-6 sm:block" />
          <Link
            href="/register"
            className={buttonVariants({
              variant: "outline",
              size: "lg",
              className: "hidden sm:inline-flex",
            })}
          >
            註冊
          </Link>
          <Link href="/login" className={buttonVariants({ size: "lg" })}>
            登入
          </Link>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              render={
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="開啟選單">
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
                    className="rounded-md px-3 py-3 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
