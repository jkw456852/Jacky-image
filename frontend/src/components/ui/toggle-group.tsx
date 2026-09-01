"use client"

import * as React from "react"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"

import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = {
  value: T
  label?: React.ReactNode
  icon?: React.ReactNode
  disabled?: boolean
  title?: string
}

/**
 * antd `<Segmented>` 的 shadcn 替代：单选、值非空（不可取消选中）。
 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "sm",
  className,
  disabled,
}: {
  value: T
  onChange: (value: T) => void
  options: SegmentedOption<T>[]
  size?: "sm" | "default"
  className?: string
  disabled?: boolean
}) {
  return (
    <ToggleGroupPrimitive
      value={[value]}
      disabled={disabled}
      onValueChange={(group) => {
        const next = group[group.length - 1]
        if (next && next !== value) onChange(next as T)
      }}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5",
        className
      )}
    >
      {options.map((option) => (
        <TogglePrimitive
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          title={option.title}
          className={cn(
            "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[pressed]:bg-card data-[pressed]:text-foreground data-[pressed]:shadow-sm [&_svg]:size-4 [&_svg]:shrink-0",
            size === "sm" ? "h-7 text-xs" : "h-8 text-sm"
          )}
        >
          {option.icon}
          {option.label}
        </TogglePrimitive>
      ))}
    </ToggleGroupPrimitive>
  )
}

export { Segmented, ToggleGroupPrimitive as ToggleGroup, TogglePrimitive as Toggle }
