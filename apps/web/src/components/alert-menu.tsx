import { ExternalLinkIcon } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

/**
 * Right-clicking (or long-pressing) an Alert wherever it is listed offers to open it in the
 * CrowdStrike Falcon console. `children` must be one element that can hold a ref. With no
 * `falconUrl` (its detection didn't link to Falcon, or the viewer is a Guest), `children` are left as they are.
 */
export function AlertMenu({
  falconUrl,
  children,
  className,
  ...rest
}: { falconUrl: string | null | undefined; children: ReactElement } & Omit<ComponentProps<"span">, "children">) {
  if (!falconUrl) return children;
  return (
    <ContextMenu>
      {/* The text stays selectable: the trigger would otherwise make it select-none. */}
      <ContextMenuTrigger asChild className={cn("select-text", className)} {...rest}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => void window.open(falconUrl, "_blank", "noopener,noreferrer")}>
          <ExternalLinkIcon aria-hidden />
          Open in CrowdStrike
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
