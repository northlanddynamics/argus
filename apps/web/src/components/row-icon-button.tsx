import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A row's action as an icon, named by a tooltip on hover or focus and by `aria-label` for screen
 * readers (on the button, or on the link it wraps with `asChild`). Muted until its row is pointed at.
 */
export function RowIconButton({ label, children, ...props }: { label: string } & Omit<ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="quiet" size="icon-sm" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
