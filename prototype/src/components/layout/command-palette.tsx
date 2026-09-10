"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { IconBuildingFactory2, IconClipboardText, IconSearch, IconUser, IconUsersGroup } from "@tabler/icons-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { navForRole } from "@/lib/nav-config";
import { ACCOUNTS, GROUPS, INDUSTRY, MANAGED_ITEMS, type Role } from "@/lib/fixtures";

/**
 * ⌘K 搜尋面板（Roy 2026-09-09：「一點開就跳一個出來」那種）。cmdk＋shadcn command。
 * 原型：搜頁面、組別、學生（管理員）、項目、合作案；正式版接 DB。
 */
export function CommandPalette({ role, open, onOpenChange }: { role: Role; open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const base = `/dashboard/${role}`;
  const pages = navForRole(role).flatMap((g) => g.items.map((i) => ({ label: i.label, href: base + i.href, group: g.title })));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onOpenChange(!open); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="palette top-[14vh] w-[min(640px,calc(100%-2rem))] translate-y-0 gap-0 rounded-2xl p-0 sm:max-w-none">
        <DialogTitle className="sr-only">搜尋</DialogTitle>
        <DialogDescription className="sr-only">搜尋頁面、組別、學生與項目</DialogDescription>
        <Command className="rounded-2xl bg-popover p-0">
          <div className="flex items-center gap-3 border-b border-border px-5">
            <IconSearch className="size-5 shrink-0 text-muted-foreground" />
            <CommandInput placeholder="搜尋頁面、組別、學生、項目…" className="h-14 w-full bg-transparent text-[17px] outline-none placeholder:text-muted-foreground" wrapperClassName="flex-1" />
            <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">Esc</kbd>
          </div>
          <CommandList className="max-h-[360px] p-2">
            <CommandEmpty>找不到符合的內容</CommandEmpty>
            <CommandGroup heading="頁面">
              {pages.map((p) => (
                <CommandItem key={p.href} value={`${p.label} ${p.group}`} onSelect={() => go(p.href)} className="h-10 rounded-lg px-3 text-[14px]">
                  <IconClipboardText className="size-4 text-muted-foreground" />
                  <span>{p.label}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{p.group}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {role !== "student" ? (
              <CommandGroup heading="組別">
                {GROUPS.map((g) => (
                  <CommandItem key={g.id} value={`${g.no} ${g.title}`} onSelect={() => go(`${base}/groups`)} className="h-10 rounded-lg px-3 text-[14px]">
                    <IconUsersGroup className="size-4 text-muted-foreground" />
                    <span className="tabular w-14 shrink-0 text-xs font-semibold text-muted-foreground">{g.no}</span>
                    <span className="truncate">{g.title.replace(/（產學：.*）/, "")}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {role === "admin" ? (
              <CommandGroup heading="學生">
                {ACCOUNTS.filter((a) => a.role === "student").slice(0, 8).map((a) => (
                  <CommandItem key={a.id} value={`${a.name} ${a.studentNo ?? ""}`} onSelect={() => go(`${base}/accounts`)} className="h-10 rounded-lg px-3 text-[14px]">
                    <IconUser className="size-4 text-muted-foreground" />
                    <span>{a.name}</span>
                    <span className="tabular ml-auto text-xs text-muted-foreground">{a.studentNo}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="項目">
              {MANAGED_ITEMS.map((i) => (
                <CommandItem key={i.id} value={i.title} onSelect={() => go(`${base}/affairs/${i.id}`)} className="h-10 rounded-lg px-3 text-[14px]">
                  <IconClipboardText className="size-4 text-muted-foreground" />
                  <span className="truncate">{i.title}</span>
                  {i.dueAt ? <span className="tabular ml-auto text-xs text-muted-foreground">{i.dueAt.slice(5)} 截止</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="產學合作">
              {INDUSTRY.map((c) => (
                <CommandItem key={c.id} value={`${c.company} ${c.title}`} onSelect={() => go(`${base}/industry`)} className="h-10 rounded-lg px-3 text-[14px]">
                  <IconBuildingFactory2 className="size-4 text-muted-foreground" />
                  <span className="truncate">{c.company}・{c.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
