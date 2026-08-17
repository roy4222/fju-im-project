"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { IconSearch, IconSwitchHorizontal } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { navForRole, ROLE_LABEL } from "@/lib/nav-config";
import type { Role } from "@/lib/fixtures";

const ROLES: Role[] = ["student", "teacher", "admin"];

/** 頁面標題取自導覽設定，避免同一個名稱在兩處各寫一次而走鐘 */
function titleFor(role: Role, pathname: string): string {
  const base = `/dashboard/${role}`;
  const items = navForRole(role).flatMap((g) => g.items);
  const match = items
    .filter((i) => (i.href === "" ? pathname === base : pathname.startsWith(base + i.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.label ?? "專題管理平台";
}

export function DashboardHeader({ role }: { role: Role }) {
  const router = useRouter();
  const pathname = usePathname();
  const title = titleFor(role, pathname);

  function switchRole(next: Role) {
    // 原型用途：把路徑上的角色換掉，其餘子路徑保留，方便比較同一頁在不同角色的樣子
    router.push(pathname.replace(`/dashboard/${role}`, `/dashboard/${next}`));
  }

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-1 h-5" />
      <h1 className="truncate text-sm font-semibold">{title}</h1>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="lg"
          className="hidden w-56 justify-start gap-2 text-muted-foreground sm:inline-flex"
        >
          <IconSearch className="size-4" />
          <span className="text-sm">搜尋組別、學生、項目…</span>
          <kbd className="ml-auto rounded border border-border bg-muted px-1.5 text-[10px] font-medium">
            ⌘K
          </kbd>
        </Button>

        {/* 原型專用：正式版的角色切換只在「一個帳號持有多個角色」時出現（MOC §2.1） */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="lg" className="gap-2">
                <IconSwitchHorizontal className="size-4" />
                <span className="hidden sm:inline">{ROLE_LABEL[role]}</span>
                <Badge variant="outline" className="hidden text-[10px] lg:inline-flex">
                  原型
                </Badge>
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>切換檢視角色</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {ROLES.map((r) => (
              <DropdownMenuItem
                key={r}
                onClick={() => switchRole(r)}
                className={r === role ? "font-semibold" : ""}
              >
                {ROLE_LABEL[r]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/">回到公開網站</Link>} />
          </DropdownMenuContent>
        </DropdownMenu>

        <ThemeToggle size="icon-lg" />
      </div>
    </header>
  );
}
