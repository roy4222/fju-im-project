"use client"

import * as React from "react"

import { cn } from "@/shared/cn"

import "./table.css"

/**
 * 橫向可捲的表格外框：右緣有漸層提示（`data-scroll` = none／start／mid／end，
 * 樣式在 table.css），`stickyFirst` 時首欄固定在左邊。外層 `table-container`
 * 不捲動、只放提示；實際捲動的是裡面那層（`className` 給它，例如 `max-h-[32rem] overflow-auto`）。
 */
function TableScroll({
  className,
  stickyFirst,
  children,
}: {
  className?: string
  stickyFirst?: boolean
  children: React.ReactNode
}) {
  const outer = React.useRef<HTMLDivElement>(null)
  const inner = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const box = inner.current
    const host = outer.current
    if (!box || !host) return
    const sync = () => {
      const max = box.scrollWidth - box.clientWidth
      host.dataset.scroll =
        max <= 1 ? "none" : box.scrollLeft <= 1 ? "start" : box.scrollLeft >= max - 1 ? "end" : "mid"
    }
    sync()
    box.addEventListener("scroll", sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(box)
    if (box.firstElementChild) ro.observe(box.firstElementChild)
    return () => {
      box.removeEventListener("scroll", sync)
      ro.disconnect()
    }
  }, [])
  return (
    <div
      ref={outer}
      data-slot="table-container"
      data-scroll="none"
      data-sticky-first={stickyFirst ? "" : undefined}
      className="table-scroll relative w-full"
    >
      <div ref={inner} className={cn("overflow-x-auto", className)}>
        {children}
      </div>
    </div>
  )
}

function Table({
  className,
  stickyFirst,
  ...props
}: React.ComponentProps<"table"> & { stickyFirst?: boolean }) {
  return (
    <TableScroll stickyFirst={stickyFirst}>
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </TableScroll>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b [&>td]:transition-colors hover:[&>td]:bg-muted/40 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg has-aria-expanded:[&>td]:bg-muted/40 data-[state=selected]:[&>td]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableScroll,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
