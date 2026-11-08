import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import type { ComponentProps, ComponentType, ReactElement, ReactNode } from "react";
import { toast } from "sonner";
import { ContextMenu, ContextMenuContent, ContextMenuSeparator, ContextMenuTrigger, ContextMenuItem } from "@/components/ui/context-menu";
import { observableCopies, observableLookups, type ObservableType } from "@/lib/observables";
import { cn } from "@/lib/utils";

const copy = (text: string, done: string) =>
  void navigator.clipboard.writeText(text).then(
    () => toast(done),
    () => toast.error("Couldn't copy to the clipboard"),
  );

const open = (href: string) => void window.open(href, "_blank", "noopener,noreferrer");

type ItemComponent = ComponentType<{ onSelect?: (event: Event) => void; children: ReactNode }>;

/** Copy it: defanged and fanged where the two differ, as it is where they don't. */
export function ObservableCopyItems({ Item, type, value }: { Item: ItemComponent; type: ObservableType; value: string }) {
  return observableCopies(type, value).map((c) => (
    <Item key={c.label} onSelect={() => copy(c.text, c.done)}>
      <CopyIcon aria-hidden />
      {c.label}
    </Item>
  ));
}

/** Open it where it can be looked up outside Argus: a hash in VirusTotal, a public IP on IPinfo.io. */
export function ObservableLookupItems({ Item, type, value }: { Item: ItemComponent; type: ObservableType; value: string }) {
  return observableLookups(type, value).map((l) => (
    <Item key={l.label} onSelect={() => open(l.href)}>
      <ExternalLinkIcon aria-hidden />
      {l.label}
    </Item>
  ));
}

/**
 * Right-clicking (or long-pressing) an Observable wherever it is shown offers to copy it and to open
 * it where it can be looked up. `children` must be one element that can hold a ref; the props an
 * outer trigger (such as the IP context popup's) gives this are passed on to it, so the two nest.
 * With no `observable`, `children` are left as they are, for lists that mix in Assets.
 */
export function ObservableMenu({
  observable,
  children,
  className,
  ...rest
}: { observable: { type: ObservableType; value: string } | null | undefined; children: ReactElement } & Omit<ComponentProps<"span">, "children">) {
  if (!observable) return children;
  const { type, value } = observable;
  const lookups = observableLookups(type, value).length > 0;
  return (
    <ContextMenu>
      {/* The value stays selectable: the trigger would otherwise make it select-none. */}
      <ContextMenuTrigger asChild className={cn("select-text", className)} {...rest}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ObservableCopyItems Item={ContextMenuItem} type={type} value={value} />
        {lookups && (
          <>
            <ContextMenuSeparator />
            <ObservableLookupItems Item={ContextMenuItem} type={type} value={value} />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
