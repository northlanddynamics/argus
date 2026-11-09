import { ChevronDownIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { namesOf, useGuests } from "@/lib/guests";
import { type InternalItem, useMarkInternal } from "@/lib/internal";
import { cn, REVEAL } from "@/lib/utils";

/** The "Internal" marker: shown on items hidden from the Case's Guests. */
export function InternalBadge() {
  return (
    <Badge variant="outline" className="border-dashed border-foreground/50">
      Internal
    </Badge>
  );
}

/** The names of the Case's Guests whose access hasn't expired: who would see an item that isn't Internal. */
export function useActiveGuestNames(number: number, enabled: boolean) {
  const guests = useGuests(number, enabled);
  return (guests.data ?? []).filter((g) => !g.expired).map((g) => g.guest.name);
}

/**
 * Who will see what is about to be added, said beside the button that adds it: "Visible to Kim
 * Patel (Guest)", or "Hidden from Guests" once marked Internal. Says nothing on a Case without
 * Guests. For Members, who are the only ones who can mark things Internal.
 */
export function Audience({ number, internal, className }: { number: number; internal: boolean; className?: string }) {
  const active = useActiveGuestNames(number, true);
  if (!active.length) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", internal ? "text-muted-foreground" : "font-medium", className)} role="status">
      {internal ? <EyeOffIcon aria-hidden className="size-3.5" /> : <EyeIcon aria-hidden className="size-3.5" />}
      {internal ? "Hidden from Guests" : `Visible to ${namesOf(active)} (${active.length === 1 ? "Guest" : "Guests"})`}
    </span>
  );
}

/** "Visible to Guests": the state of an item that isn't Internal. */
function VisibleLabel() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <EyeIcon aria-hidden className="size-3.5" />
      Visible to Guests
    </span>
  );
}

/**
 * Whether an item is Internal or visible to the Case's Guests, for Members. The state always shows;
 * with `canMark` it opens a menu to change it. Showing an item to Guests asks first when the Case has
 * Guests, naming them, and every change offers Undo. Shows nothing to Guests, who only ever see
 * items that aren't Internal.
 */
export function Visibility({
  number,
  item,
  internal,
  label,
  canMark,
  quiet = false,
}: {
  number: number;
  item: InternalItem;
  internal: boolean;
  /** What the item is called, for the menu's accessible name and the confirmation. */
  label: string;
  canMark: boolean;
  /**
   * In a list where most items aren't Internal: "Visible to Guests" waits until the row (`group/row`)
   * is pointed at or focused, so the Internal ones stand out. Internal always shows.
   */
  quiet?: boolean;
}) {
  const mark = useMarkInternal(number);
  const [confirming, setConfirming] = useState(false);
  /** Guests whose access hasn't expired: the people who would see it. */
  const active = useActiveGuestNames(number, canMark);

  const change = (next: boolean, undoable = true) =>
    mark.mutate(
      { item, internal: next },
      {
        onSuccess: () => {
          if (!undoable) return;
          toast(next ? `Marked Internal: ${label}` : `Shown to Guests: ${label}`, {
            action: { label: "Undo", onClick: () => change(!next, false) },
          });
        },
      },
    );

  const state = internal ? <InternalBadge /> : <VisibleLabel />;
  if (!canMark) return quiet && !internal ? <span className={REVEAL}>{state}</span> : state;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", quiet && !internal && !mark.error && REVEAL)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="-mx-1 h-auto px-1 py-0.5"
            aria-label={`Visibility of ${label}: ${internal ? "Internal" : "visible to Guests"}`}
            disabled={mark.isPending}
          >
            {state}
            <ChevronDownIcon aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {internal ? (
            <DropdownMenuItem onSelect={() => (active.length ? setConfirming(true) : change(false))}>
              <EyeIcon />
              Show to Guests
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => change(true)}>
              <EyeOffIcon />
              Mark Internal
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {mark.error && (
        <span role="alert" className="text-xs text-destructive">
          {mark.error.message}
        </span>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Show {label} to Guests?</AlertDialogTitle>
            <AlertDialogDescription>
              {namesOf(active)} will be able to see it. You can mark it Internal again, but they may already have seen it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it Internal</AlertDialogCancel>
            <AlertDialogAction onClick={() => change(false)}>Show to Guests</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}
