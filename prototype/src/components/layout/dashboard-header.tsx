"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { IconBell, IconCalendarDue, IconChecklist, IconChevronDown, IconLogout, IconSearch, IconSignature, IconSwitchHorizontal, IconUpload, IconUserCheck, IconUserCircle, IconWorld, IconSettings } from "@tabler/icons-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { titleFor, ROLE_LABEL } from "@/lib/nav-config";
import { DashThemeToggle } from "@/components/layout/dash-theme";
import { CommandPalette } from "@/components/layout/command-palette";
import { CURRENT_USERS, NOTIFICATIONS, type Notification, type Role } from "@/lib/fixtures";

const ROLES: Role[] = ["student", "teacher", "admin"];
const KIND_ICON: Record<Notification["kind"], typeof IconBell> = { due: IconCalendarDue, submission: IconUpload, signoff: IconSignature, grading: IconChecklist, account: IconUserCheck, system: IconSettings };

/** 後台頂列：側欄開關、頁名、搜尋（⌘K 面板）、深淺色、通知、帳號選單（含原型角色切換）。 */
export function DashboardHeader({ role }: { role: Role }) {
  const router = useRouter();
  const pathname = usePathname();
  const title = titleFor(role, pathname);
  const user = CURRENT_USERS[role];
  const notes = NOTIFICATIONS[role];
  const unread = notes.filter((n) => !n.read).length;
  const logoutForm = useRef<HTMLFormElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  function switchRole(next: Role) {
    router.push(pathname.replace(`/dashboard/${role}`, `/dashboard/${next}`));
  }

  return (
    <header className="dash-header sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-5">
      <SidebarTrigger className="size-9 rounded-lg" />
      <h1 className="ml-1 truncate text-[15px] font-bold">{title}</h1>

      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" onClick={() => setSearchOpen(true)} className="hidden h-9 w-64 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-[13px] text-muted-foreground transition-[border-color,background-color] hover:border-primary/40 hover:bg-background md:inline-flex" aria-label="搜尋">
          <IconSearch className="size-4" />
          <span className="flex-1 text-left">搜尋組別、學生、項目</span>
          <kbd className="rounded border border-border bg-background px-1.5 text-[10px] font-semibold">⌘K</kbd>
        </button>
        <button type="button" onClick={() => setSearchOpen(true)} className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden" aria-label="搜尋">
          <IconSearch className="size-4.5" />
        </button>
        <CommandPalette role={role} open={searchOpen} onOpenChange={setSearchOpen} />

        <DashThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button type="button" className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label={`通知，${unread} 則未讀`}>
                <IconBell className="size-4.5" />
                {unread ? <span className="notif-dot absolute top-2 right-2 size-2 rounded-full bg-brand" /> : null}
              </button>
            }
          />
          <DropdownMenuContent align="end" className="w-[360px] p-0">
            <DropdownMenuGroup>
              <div className="flex items-center justify-between px-4 py-3">
                <DropdownMenuLabel className="p-0 text-[15px] font-bold">通知</DropdownMenuLabel>
                {unread ? <span className="text-xs font-semibold text-brand">{unread} 則未讀</span> : null}
              </div>
              <div className="max-h-[360px] overflow-y-auto border-t border-border">
                {notes.map((n) => {
                  const Icon = KIND_ICON[n.kind];
                  return (
                    <DropdownMenuItem key={n.id} className="items-start gap-3 rounded-none px-4 py-3" render={<Link href={n.href} />}>
                      <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"><Icon className="size-4" /></span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[13px] ${n.read ? "font-medium" : "font-bold"}`}>{n.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{n.body}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="tabular text-[11px] text-muted-foreground">{n.at}</span>
                        {!n.read ? <span className="size-1.5 rounded-full bg-brand" aria-label="未讀" /> : null}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </div>
              <div className="border-t border-border p-2">
                <DropdownMenuItem className="h-9 justify-center rounded-lg text-[13px] font-semibold text-primary" render={<Link href={`/dashboard/${role}/inbox`} />}>查看全部通知</DropdownMenuItem>
              </div>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <form ref={logoutForm} method="post" action="/api/proto-role" className="hidden">
          <input type="hidden" name="role" value="guest" />
          <input type="hidden" name="returnTo" value="/" />
        </form>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button type="button" className="ml-1 inline-flex h-9 items-center gap-2 rounded-lg py-1 pr-2 pl-1 transition-colors hover:bg-accent" aria-label="帳號選單">
                <span className="inline-flex size-7 items-center justify-center rounded-full bg-brand-subtle text-xs font-bold text-brand-on-subtle">{user.name.slice(0, 1)}</span>
                <span className="hidden text-[13px] font-semibold sm:inline">{user.name}</span>
                <IconChevronDown className="hidden size-3.5 text-muted-foreground sm:inline" />
              </button>
            }
          />
          <DropdownMenuContent align="end" className="w-56 p-1.5">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">{user.name}・{ROLE_LABEL[role]}</DropdownMenuLabel>
              <DropdownMenuItem className="h-9 px-2.5 text-[14px]" render={<Link href="/account" />}><IconUserCircle /> 個人資料</DropdownMenuItem>
              <DropdownMenuItem className="h-9 px-2.5 text-[14px]" render={<Link href="/" />}><IconWorld /> 回到前台網站</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground"><IconSwitchHorizontal className="size-3.5" /> 切換角色（原型）</DropdownMenuLabel>
              {ROLES.map((r) => (
                <DropdownMenuItem key={r} onClick={() => switchRole(r)} className={`h-9 px-2.5 text-[14px] ${r === role ? "font-bold text-primary" : ""}`}>
                  {ROLE_LABEL[r]}
                  {r === role ? <span className="ml-auto text-[11px] text-muted-foreground">目前</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="h-9 px-2.5 text-[14px]" onClick={() => logoutForm.current?.requestSubmit()}><IconLogout /> 登出</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
