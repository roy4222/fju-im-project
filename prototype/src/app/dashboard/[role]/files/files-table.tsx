"use client";

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { IconFile, IconFileText, IconPhoto, IconPresentation, IconDownload, IconTrash } from "@tabler/icons-react";
import { DataTable } from "@/components/data-table/data-table";
import { Pill } from "@/components/dashboard/primitives";
import { buttonVariants } from "@/components/ui/button";

export type FileRow = { id: string; name: string; category: string; size: string; date: string; cohort: string; kind: string; uploader: string; refs: number };
const KIND_LABEL: Record<string, string> = { public: "公開資源", attachment: "公告附件", submission: "組別繳交" };

function icon(n: string) {
  if (n.endsWith(".pdf")) return <IconFileText className="size-4 text-muted-foreground" />;
  if (n.endsWith(".pptx")) return <IconPresentation className="size-4 text-muted-foreground" />;
  if (/\.(jpg|png)$/.test(n)) return <IconPhoto className="size-4 text-muted-foreground" />;
  return <IconFile className="size-4 text-muted-foreground" />;
}

export function FilesTable({ rows, initialKind }: { rows: FileRow[]; initialKind?: string }) {
  const columns: ColumnDef<FileRow, unknown>[] = useMemo(() => [
    { accessorKey: "name", meta: { label: "檔名", width: "320px" }, header: "檔名", cell: ({ row }) => <span className="flex items-center gap-2 font-semibold">{icon(row.original.name)}<span className="truncate">{row.original.name}</span></span> },
    { accessorKey: "kind", meta: { label: "類型", width: "110px" }, header: "類型", filterFn: (row, id, v: string[]) => v.includes(String(row.getValue(id))), cell: ({ row }) => <Pill tone={row.original.kind === "submission" ? "brand" : "default"}>{KIND_LABEL[row.original.kind]}</Pill> },
    { accessorKey: "category", meta: { label: "項目", width: "200px" }, header: "項目", cell: ({ row }) => <span className="block truncate text-sm text-muted-foreground">{row.original.category}</span> },
    { accessorKey: "uploader", meta: { label: "上傳者", width: "110px" }, header: "上傳者", cell: ({ row }) => <span className="text-sm">{row.original.uploader}</span> },
    { accessorKey: "size", meta: { label: "大小", width: "90px" }, header: "大小", cell: ({ row }) => <span className="tabular text-sm text-muted-foreground">{row.original.size}</span> },
    { accessorKey: "date", meta: { label: "日期", width: "110px" }, header: "日期", cell: ({ row }) => <span className="tabular text-sm text-muted-foreground">{row.original.date}</span> },
    { accessorKey: "refs", meta: { label: "引用", width: "70px" }, header: "引用", cell: ({ row }) => <span className="tabular text-sm text-muted-foreground">{row.original.refs}</span> },
    { id: "actions", meta: { label: "操作", width: "120px" }, enableSorting: false, enableHiding: false, header: "操作", cell: ({ row }) => <span className="flex gap-1"><button type="button" className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} aria-label="下載"><IconDownload /></button><button type="button" disabled={row.original.refs > 0} title={row.original.refs > 0 ? "仍被引用，不可刪除" : undefined} className={buttonVariants({ size: "sm", variant: "ghost", className: "press rounded-lg" })} aria-label="刪除"><IconTrash /></button></span> },
  ], []);
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchColumnId="name"
      searchPlaceholder="搜尋檔名"
      initialColumnFilters={initialKind && initialKind !== "all" ? [{ id: "kind", value: [initialKind] }] : undefined}
      facets={[{ columnId: "kind", label: "類型", options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) }]}
      emptyTitle="沒有檔案"
    />
  );
}
