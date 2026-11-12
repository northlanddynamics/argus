import { ExternalLinkIcon } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

/**
 * Right-clicking (or long-pressing) an Alert wherever it is listed offers to open it in the
 * CrowdStrike Falcon console, after any `actions` (menu items) the list offers. `children` must be one
 * element that can hold a ref. With no `falconUrl` (its detection didn't link to Falcon, or the viewer
 * is a Guest) and no `actions`, `children` are left as they are.
 */
export function AlertMenu({
  falconUrl,
  actions,
  children,
  className,
  ...rest
}: {
  falconUrl: string | null | undefined;
  actions?: ReactNode;
  children: ReactElement;
} & Omit<ComponentProps<"span">, "children">) {
  if (!falconUrl && !actions) return children;
  return (
    <ContextMenu>
      {/* The text stays selectable: the trigger would otherwise make it select-none. */}
      <ContextMenuTrigger asChild className={cn("select-text", className)} {...rest}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {actions}
        {actions && falconUrl && <ContextMenuSeparator />}
        {falconUrl && (
          <ContextMenuItem onSelect={() => void window.open(falconUrl, "_blank", "noopener,noreferrer")}>
            <ExternalLinkIcon aria-hidden />
            Open in CrowdStrike
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
