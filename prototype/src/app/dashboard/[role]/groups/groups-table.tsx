"use client";

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { IconDownload } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable, type FacetFilter } from "@/components/data-table/data-table";
import { TEACHERS, type Group, type Role } from "@/lib/fixtures";
import { AssignDialog, ClaimDialog } from "@/components/dashboard/group-actions";
import { GroupDetailSheet } from "@/components/dashboard/group-detail-sheet";

type Row = Group & { advisorName: string; memberNames: string; confirmed: number };

/**
 * 分組表格。Codex 09-10 A-04：管理員點組別開詳情；g-07 forming 顯示「成立中 3/5」而不是「已成立」。
 */
export function GroupsTable({ groups, role, base = "/dashboard/admin" }: { groups: Group[]; role: Role; base?: string }) {
  const rows: Row[] = useMemo(
    () =>
      groups.map((g) => ({
        ...g,
        advisorName: TEACHERS.find((t) => t.id === g.advisorId)?.name ?? "尚未指派",
        memberNames: g.members.map((m) => m.name).join("、"),
        confirmed: g.members.filter((m) => m.confirmed).length,
      })),
    [groups],
  );

  const columns: ColumnDef<Row, unknown>[] = useMemo(
    () => [
      {
        id: "select",
        meta: { label: "勾選", width: "44px" },
        enableSorting: false,
        enableHiding: false,
        header: ({ table }) => (
          // Base UI 的 indeterminate 是獨立 prop，不是 checked 的第三個值
          <Checkbox checked={table.getIsAllPageRowsSelected()} indeterminate={table.getIsSomePageRowsSelected()} onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)} aria-label="全選本頁" />
        ),
        cell: ({ row }) => <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} aria-label={`選取 ${row.original.no}`} />,
      },
      {
        accessorKey: "no",
        meta: { label: "組別", width: "104px" },
        header: "組別",
        cell: ({ row }) =>
          role === "admin" ? (
            <GroupDetailSheet group={row.original} base={base} trigger={<button type="button" className="tabular rounded-md text-sm font-bold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-brand">{row.original.no}</button>} />
          ) : (
            <span className="tabular text-sm">{row.original.no}</span>
          ),
      },
      {
        accessorKey: "title",
        meta: { label: "專題題目", width: "300px" },
        header: "專題題目",
        cell: ({ row }) => (
          // 長內容不撐高整列：單行 + ellipsis + tooltip（MOC §10.3）
          <Tooltip>
            <TooltipTrigger render={<span className="block truncate text-sm font-medium">{row.original.title}</span>} />
            <TooltipContent className="max-w-xs">{row.original.title}</TooltipContent>
          </Tooltip>
        ),
      },
      {
        accessorKey: "type",
        meta: { label: "類型", width: "104px" },
        header: "類型",
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ row }) =>
          row.original.type === "INDUSTRY" ? (
            <Badge variant="outline" className="border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle">產學合作</Badge>
          ) : (
            <Badge variant="outline" className="text-[11px] text-muted-foreground">一般專題</Badge>
          ),
      },
      {
        accessorKey: "advisorName",
        meta: { label: "指導老師", width: "128px" },
        header: "指導老師",
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ row }) => (row.original.advisorId ? <span className="text-sm">{row.original.advisorName}</span> : <span className="text-sm font-semibold text-destructive">尚未指派</span>),
      },
      {
        accessorKey: "memberNames",
        meta: { label: "組員", width: "240px" },
        header: "組員",
        enableSorting: false,
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger render={<span className="block truncate text-sm text-muted-foreground">{row.original.memberNames}</span>} />
            <TooltipContent className="max-w-xs">{row.original.memberNames}</TooltipContent>
          </Tooltip>
        ),
      },
      {
        id: "memberCount",
        meta: { label: "人數", width: "80px" },
        header: "人數",
        accessorFn: (r) => r.members.length,
        cell: ({ row }) => {
          const n = row.original.members.length;
          return <span className={`tabular text-sm ${n !== 5 ? "font-semibold text-warning-on-subtle" : ""}`}>{n} 人</span>;
        },
      },
      {
        accessorKey: "status",
        meta: { label: "狀態", width: "120px" },
        header: "狀態",
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ row }) =>
          row.original.status === "exception" ? (
            <Badge variant="outline" className="border-warning/35 bg-warning-subtle text-[11px] text-warning-on-subtle">例外組</Badge>
          ) : row.original.status === "forming" ? (
            <Badge variant="outline" className="tabular border-brand/30 bg-brand-subtle text-[11px] text-brand-on-subtle">成立中 {row.original.confirmed}/{row.original.members.length}</Badge>
          ) : (
            <Badge variant="outline" className="border-success/30 bg-success-subtle text-[11px] text-success-on-subtle">已成立</Badge>
          ),
      },
      {
        id: "actions",
        meta: { label: "操作", width: "148px" },
        enableSorting: false,
        enableHiding: false,
        header: "操作",
        cell: ({ row }) => {
          const g = row.original;
          const claimable = g.type === "INDUSTRY" && g.advisorId === null;
          if (role === "teacher" && claimable) return <ClaimDialog groupNo={g.no} title={g.title} />;
          if (role === "admin") return <AssignDialog groupNo={g.no} current={g.advisorId ? g.advisorName : undefined} />;
          return <span className="text-xs text-muted-foreground">—</span>;
        },
      },
    ],
    [role, base],
  );

  const facets: FacetFilter[] = [
    { columnId: "type", label: "類型", options: [{ value: "GENERAL", label: "一般專題" }, { value: "INDUSTRY", label: "產學合作" }] },
    { columnId: "advisorName", label: "指導老師", options: [...TEACHERS.map((t) => ({ value: t.name, label: t.name })), { value: "尚未指派", label: "尚未指派" }] },
    { columnId: "status", label: "狀態", options: [{ value: "active", label: "已成立" }, { value: "forming", label: "成立中" }, { value: "exception", label: "例外組" }] },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchColumnId="title"
      searchPlaceholder="搜尋專題題目…"
      facets={facets}
      emptyTitle="本屆尚無成立的組別"
      emptyHint="五位學生逐一確認後，組別會自動成立並出現在這裡。"
      bulkActions={(selected, clear) => (
        <>
          <span className="inline-flex items-center gap-1.5"><Button variant="outline" size="sm" className="gap-1" disabled title="尚未提供"><IconDownload className="size-3.5" />匯出所選 {selected.length} 筆 CSV</Button><span className="text-[11px] text-muted-foreground">尚未提供</span></span>
          <Button variant="ghost" size="sm" onClick={clear}>取消選取</Button>
        </>
      )}
    />
  );
}
