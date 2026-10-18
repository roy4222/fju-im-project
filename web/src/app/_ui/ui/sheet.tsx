"use client"

import * as React from "react"

import { cn } from "@/shared/cn"
import { Button } from "@/app/_ui/ui/button"
import { IconX } from "@tabler/icons-react"

// 側邊抽屜（shadcn Sheet 的介面）。用原生 `<dialog>` 的 showModal()：背景 inert、焦點留在抽屜裡、
// Esc 關閉都是瀏覽器的，跟後台其他對話框一樣（`_ui/dashboard/section-dialog.tsx`）。
// 原本包 base-ui Dialog，但它只有前台手機選單與後台手機側欄用到，卻跟著外殼進了每頁都載入的 bundle
// （約 3.5 KB gzip，全站 250 KB 上限，Q106）。

type SheetContextValue = {
  open: boolean
  setOpen: (open: boolean) => void
  titleId: string
  descriptionId: string
  hasDescription: boolean
  setHasDescription: (has: boolean) => void
}

const SheetContext = React.createContext<SheetContextValue | null>(null)

function useSheet() {
  const ctx = React.useContext(SheetContext)
  if (!ctx) throw new Error("Sheet 元件要放在 <Sheet> 裡。")
  return ctx
}

function Sheet({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen)
  const open = openProp ?? uncontrolled
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange]
  )
  const titleId = React.useId()
  const descriptionId = React.useId()
  const [hasDescription, setHasDescription] = React.useState(false)
  const value = React.useMemo(
    () => ({ open, setOpen, titleId, descriptionId, hasDescription, setHasDescription }),
    [open, setOpen, titleId, descriptionId, hasDescription]
  )
  return <SheetContext.Provider value={value}>{children}</SheetContext.Provider>
}

type RenderProps = { render?: React.ReactElement<React.ComponentProps<"button">> } & React.ComponentProps<"button">

/** 開關抽屜的按鈕；`render` 換成自己的元素（例如 `<Button>`），點擊與 aria 屬性會接上去。 */
function SheetTrigger({ render, onClick, ...props }: RenderProps) {
  const { open, setOpen } = useSheet()
  const element = render ?? <button type="button" />
  return React.cloneElement(element, {
    "data-slot": "sheet-trigger",
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    ...props,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      element.props.onClick?.(event)
      onClick?.(event)
      if (!event.defaultPrevented) setOpen(!open)
    },
  } as React.ComponentProps<"button">)
}

function SheetClose({ render, onClick, ...props }: RenderProps) {
  const { setOpen } = useSheet()
  const element = render ?? <button type="button" />
  return React.cloneElement(element, {
    "data-slot": "sheet-close",
    ...props,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      element.props.onClick?.(event)
      onClick?.(event)
      if (!event.defaultPrevented) setOpen(false)
    },
  } as React.ComponentProps<"button">)
}

function SheetContent({
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<"dialog"> & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  const { open } = useSheet()
  // 關著就不放進 DOM（跟原本 base-ui Portal 一樣）。
  return open ? <SheetPopup side={side} showCloseButton={showCloseButton} {...props} /> : null
}

function SheetPopup({
  className,
  children,
  side,
  showCloseButton,
  onCancel,
  onClick,
  ...props
}: React.ComponentProps<"dialog"> & {
  side: "top" | "right" | "bottom" | "left"
  showCloseButton: boolean
}) {
  const { setOpen, titleId, descriptionId, hasDescription } = useSheet()
  const ref = React.useRef<HTMLDialogElement>(null)

  React.useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // 關掉時元素直接拿掉，瀏覽器不會自己把焦點還回去：記下打開前在哪，關掉時還原。
    const previous = document.activeElement
    if (!dialog.open) dialog.showModal()
    // 原生 modal 不鎖背景捲動；原本的 base-ui 會鎖。
    const root = document.documentElement
    root.classList.add("overflow-hidden")
    return () => {
      root.classList.remove("overflow-hidden")
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      data-slot="sheet-content"
      data-side={side}
      aria-labelledby={titleId}
      aria-describedby={hasDescription ? descriptionId : undefined}
      onCancel={(event) => {
        onCancel?.(event)
        // Esc：交給 React 的 open 狀態關，不讓瀏覽器自己關（狀態才不會不同步）。
        event.preventDefault()
        setOpen(false)
      }}
      onClick={(event) => {
        onClick?.(event)
        // 點到抽屜外面（::backdrop 的點擊也算在 dialog 上）就關。
        if (event.target !== event.currentTarget) return
        const r = event.currentTarget.getBoundingClientRect()
        const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom
        if (!inside) setOpen(false)
      }}
      className={cn(
        "fixed m-0 flex max-h-none max-w-none flex-col gap-4 border-0 bg-popover bg-clip-padding p-0 text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out backdrop:bg-black/10 starting:opacity-0 supports-backdrop-filter:backdrop:backdrop-blur-xs data-[side=bottom]:inset-x-0 data-[side=bottom]:top-auto data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:w-full data-[side=bottom]:border-t data-[side=bottom]:starting:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:right-auto data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:starting:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:left-auto data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:starting:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:bottom-auto data-[side=top]:h-auto data-[side=top]:w-full data-[side=top]:border-b data-[side=top]:starting:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <SheetClose
          render={
            <Button
              variant="ghost"
              className="absolute top-3 right-3"
              size="icon-sm"
            />
          }
        >
          <IconX
          />
          <span className="sr-only">關閉</span>
        </SheetClose>
      )}
    </dialog>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<"h2">) {
  const { titleId } = useSheet()
  return (
    <h2
      id={titleId}
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  const { descriptionId, setHasDescription } = useSheet()
  React.useEffect(() => {
    setHasDescription(true)
    return () => setHasDescription(false)
  }, [setHasDescription])
  return (
    <p
      id={descriptionId}
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
