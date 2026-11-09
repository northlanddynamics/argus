"use client"

import * as React from "react"
import { cn } from "cn"

import { useColumnResize, type ColumnResizer } from "@/hooks/use-column-resize"

const ColumnResizeContext = React.createContext<ColumnResizer | null>(null)

function Table({ className, ref, ...props }: React.ComponentProps<"table">) {
  const tableRef = React.useRef<HTMLTableElement | null>(null)
  const resizer = useColumnResize(tableRef)
  const setRef = React.useCallback(
    (node: HTMLTableElement | null) => {
      tableRef.current = node
      if (typeof ref === "function") return ref(node)
      if (ref) ref.current = node
    },
    [ref]
  )
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <ColumnResizeContext value={resizer}>
        <table
          ref={setRef}
          data-slot="table"
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </ColumnResizeContext>
    </div>
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
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({
  className,
  children,
  ...props
}: React.ComponentProps<"th">) {
  const resizer = React.useContext(ColumnResizeContext)
  React.useLayoutEffect(() => {
    resizer?.changed()
    return () => resizer?.changed()
  }, [resizer, props.colSpan])
  return (
    <th
      data-slot="table-head"
      className={cn(
        "relative h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    >
      {children}
      {resizer && (
        // Drag to resize the column; double-click to put it back.
        <span
          aria-hidden
          data-slot="table-resize-handle"
          title="Drag to resize · double-click to reset"
          className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none select-none after:absolute after:inset-y-2.5 after:right-0 after:w-px after:rounded-full after:bg-border after:opacity-0 after:transition-opacity in-[tr:hover]:after:opacity-100 hover:after:bg-muted-foreground/60 data-resizing:after:inset-y-0 data-resizing:after:bg-ring data-resizing:after:opacity-100 in-data-resize-hidden:hidden"
          onPointerDown={(event) =>
            resizer.start(event, event.currentTarget.parentElement as HTMLTableCellElement)
          }
          onDoubleClick={(event) =>
            resizer.reset(event.currentTarget.parentElement as HTMLTableCellElement)
          }
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </th>
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
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
