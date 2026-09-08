"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { IconArrowRight } from "@tabler/icons-react";
import { DataTable } from "@/components/data-table/data-table";
import { Tag } from "@/components/public/blocks";
import type { IndustryItem } from "@/lib/fixtures";

const columns: ColumnDef<IndustryItem, unknown>[] = [
  { accessorKey: "company", header: "公司名稱", cell: ({ row }) => <span className="font-bold">{row.original.company}</span>, meta: { width: 240 } },
  { accessorKey: "department", header: "需求部門", cell: ({ row }) => <span className="text-muted-foreground">{row.original.department}</span>, meta: { width: 170 } },
  { accessorKey: "title", header: "合作內容", cell: ({ row }) => <span title={row.original.title}>{row.original.title}</span>, meta: { width: 300 } },
  { accessorKey: "advisorName", header: "負責老師", cell: ({ row }) => <span className="text-muted-foreground">{row.original.advisorName}</span>, meta: { width: 110 }, filterFn: "equals" },
  { accessorKey: "publishedAt", header: "發布日期", cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.publishedAt}</span>, meta: { width: 120 } },
  {
    accessorKey: "status",
    header: "狀態",
    cell: ({ row }) => (row.original.status === "claimed" ? <Tag tone="navy">已有 {row.original.linkedGroups} 組</Tag> : <Tag>未指派</Tag>),
    meta: { width: 110 },
    filterFn: "equals",
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => (
      <Link href={`/industry/${row.original.id}`} className="inline-flex items-center gap-1 font-semibold text-primary hover:text-brand">
        詳細資料 <IconArrowRight className="size-4" />
      </Link>
    ),
    meta: { width: 110 },
    enableSorting: false,
  },
];

/** 產學合作列表：可搜尋、排序、篩選（Roy 2026-09-07 要求）。共用 Data Table，規格 §10.3。 */
export function IndustryTable({ items }: { items: IndustryItem[] }) {
  const advisors = [...new Set(items.map((i) => i.advisorName))].map((a) => ({ value: a, label: a }));
  return (
    <DataTable
      columns={columns}
      data={items}
      searchColumnId="company"
      searchPlaceholder="搜尋公司名稱"
      facets={[
        { columnId: "status", label: "狀態", options: [{ value: "open", label: "未指派" }, { value: "claimed", label: "已有組別" }] },
        { columnId: "advisorName", label: "負責老師", options: advisors },
      ]}
      emptyTitle="目前沒有公開的產學合作案"
      emptyHint="老師建立並公開合作案後會出現在這裡。"
    />
  );
}
