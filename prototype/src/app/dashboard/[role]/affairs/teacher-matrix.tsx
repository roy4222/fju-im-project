"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { StateBadge } from "@/components/dashboard/primitives";
import { GROUP_SUBMISSIONS, type Group, type ManagedItem, type SubmissionState } from "@/lib/fixtures";

type Row = { id: string; no: string; title: string; type: string } & Record<string, unknown>;

/** 老師：指導組別 × 收件項目，用共用 Data Table（Roy 2026-09-08：表格要統一元件） */
export function TeacherMatrix({ groups, items, base }: { groups: Group[]; items: ManagedItem[]; base: string }) {
  const rows: Row[] = useMemo(() => groups.map((g) => {
    const r: Row = { id: g.id, no: g.no, title: g.title.replace(/（產學：.*）/, ""), type: g.type === "INDUSTRY" ? "產學" : "一般" };
    for (const i of items) r[i.id] = GROUP_SUBMISSIONS[i.id]?.find((x) => x.groupId === g.id)?.state ?? "todo";
    return r;
  }), [groups, items]);
  const columns: ColumnDef<Row, unknown>[] = useMemo(() => [
    { accessorKey: "no", meta: { label: "組別", width: "96px" }, header: "組別", cell: ({ row }) => <span className="tabular text-sm font-semibold">{row.original.no}</span> },
    { accessorKey: "title", meta: { label: "題目", width: "260px" }, header: "題目", cell: ({ row }) => <span className="block truncate text-sm">{row.original.title}</span> },
    ...items.map<ColumnDef<Row, unknown>>((i) => ({
      accessorKey: i.id,
      meta: { label: i.title, width: "180px" },
      header: () => <span className="block truncate">{i.title}<span className="tabular ml-1 font-normal text-muted-foreground">{i.dueAt?.slice(5)}</span></span>,
      filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))),
      cell: ({ row }) => <Link href={`${base}/affairs/${i.id}?group=${row.original.id}`} className="inline-flex"><StateBadge state={row.original[i.id] as SubmissionState} /></Link>,
    })),
  ], [items, base]);
  return <DataTable columns={columns} data={rows} searchColumnId="title" searchPlaceholder="搜尋題目" emptyTitle="沒有指導組別" />;
}
