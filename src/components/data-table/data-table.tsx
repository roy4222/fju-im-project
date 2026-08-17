"use client";

import { useState } from "react";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconSelector,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";

export type FacetFilter = {
  columnId: string;
  label: string;
  options: { value: string; label: string }[];
};

/**
 * 共用 Data Table。規格見 MOC §10.3：
 *  - 固定欄寬、cell 預設單行、長內容 ellipsis
 *  - 整張表可水平捲動，右緣有漸層提示還有欄位（這是功能性漸層，不是裝飾）
 *  - sticky header
 *  - 搜尋、篩選、排序、分頁、勾選、全選目前篩選結果、批次動作
 *  - 空白／載入／無搜尋結果為不同狀態
 */
export function DataTable<T>({
  columns,
  data,
  searchPlaceholder = "搜尋…",
  searchColumnId,
  facets = [],
  bulkActions,
  loading = false,
  emptyTitle = "目前沒有資料",
  emptyHint,
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  searchPlaceholder?: string;
  searchColumnId?: string;
  facets?: FacetFilter[];
  bulkActions?: (selected: T[], clear: () => void) => React.ReactNode;
  loading?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState({});
  const [search, setSearch] = useState("");

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    initialState: { pagination: { pageSize: 10 } },
  });

  const selectedRows = table
    .getFilteredSelectedRowModel()
    .rows.map((r) => r.original);
  const hasFilters = columnFilters.length > 0 || search.length > 0;

  function applySearch(value: string) {
    setSearch(value);
    if (searchColumnId) table.getColumn(searchColumnId)?.setFilterValue(value);
  }

  function resetAll() {
    setSearch("");
    setColumnFilters([]);
    if (searchColumnId) table.getColumn(searchColumnId)?.setFilterValue("");
  }

  return (
    <div className="space-y-3">
      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => applySearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-9 w-full pl-8 sm:w-72"
            aria-label={searchPlaceholder}
          />
        </div>

        {facets.map((facet) => {
          const column = table.getColumn(facet.columnId);
          const selected = new Set((column?.getFilterValue() as string[]) ?? []);
          return (
            <DropdownMenu key={facet.columnId}>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="lg" className="gap-1.5">
                    {facet.label}
                    {selected.size > 0 ? (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {selected.size}
                      </Badge>
                    ) : null}
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel>{facet.label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {facet.options.map((opt) => (
                  <DropdownMenuCheckboxItem
                    key={opt.value}
                    checked={selected.has(opt.value)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected);
                      if (checked) next.add(opt.value);
                      else next.delete(opt.value);
                      column?.setFilterValue(next.size ? [...next] : undefined);
                    }}
                  >
                    {opt.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}

        {hasFilters ? (
          <Button variant="ghost" size="lg" onClick={resetAll} className="gap-1">
            <IconX className="size-4" /> 清除條件
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="lg" className="ml-auto gap-1.5">
                <IconSettings className="size-4" />
                <span className="hidden sm:inline">欄位</span>
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>顯示欄位</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={c.getIsVisible()}
                  onCheckedChange={(v) => c.toggleVisibility(!!v)}
                >
                  {typeof c.columnDef.meta === "object" &&
                  c.columnDef.meta !== null &&
                  "label" in c.columnDef.meta
                    ? String((c.columnDef.meta as { label: string }).label)
                    : c.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 批次動作列：只在有勾選時出現 */}
      {selectedRows.length > 0 && bulkActions ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2">
          <span className="tabular text-sm font-medium">
            已選 {selectedRows.length} 筆
          </span>
          <span className="text-xs text-muted-foreground">
            （目前篩選結果共 {table.getFilteredRowModel().rows.length} 筆）
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {bulkActions(selectedRows, () => setRowSelection({}))}
          </div>
        </div>
      ) : null}

      {/* 表格本體。overflow-x-auto 讓整張表可水平捲動 */}
      <div className="relative rounded-lg border border-border">
        <div className="max-h-[32rem] overflow-auto">
          <Table className="w-full table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-muted">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    const width = (
                      header.column.columnDef.meta as { width?: string } | undefined
                    )?.width;
                    return (
                      <TableHead
                        key={header.id}
                        style={width ? { width } : undefined}
                        className="whitespace-nowrap"
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1 rounded font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                            {sorted === "asc" ? (
                              <IconArrowUp className="size-3.5" />
                            ) : sorted === "desc" ? (
                              <IconArrowDown className="size-3.5" />
                            ) : (
                              <IconSelector className="size-3.5 opacity-50" />
                            )}
                          </button>
                        ) : (
                          flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {table.getVisibleLeafColumns().map((c) => (
                      <TableCell key={c.id}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={table.getVisibleLeafColumns().length}
                    className="h-40 text-center"
                  >
                    {/* 「沒有搜尋結果」與「本來就沒有資料」是不同狀態 */}
                    {hasFilters ? (
                      <div className="space-y-1">
                        <p className="text-sm font-medium">沒有符合條件的資料</p>
                        <p className="text-xs text-muted-foreground">
                          試著放寬搜尋字詞或清除篩選條件。
                        </p>
                        <Button
                          variant="outline"
                          size="lg"
                          onClick={resetAll}
                          className="mt-2"
                        >
                          清除條件
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-sm font-medium">{emptyTitle}</p>
                        {emptyHint ? (
                          <p className="text-xs text-muted-foreground">{emptyHint}</p>
                        ) : null}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() ? "selected" : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="truncate">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* 分頁 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="tabular text-xs text-muted-foreground">
          共 {table.getFilteredRowModel().rows.length} 筆
          {selectedRows.length > 0 ? `・已選 ${selectedRows.length} 筆` : ""}
        </p>
        <div className="flex items-center gap-2">
          <span className="tabular text-xs text-muted-foreground">
            第 {table.getState().pagination.pageIndex + 1} / {table.getPageCount() || 1} 頁
          </span>
          <Button
            variant="outline"
            size="icon-lg"
            aria-label="上一頁"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <IconChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-lg"
            aria-label="下一頁"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <IconChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
