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

/** The "Internal" marker: shown on items hidden from the Case's Guests. */
export function InternalBadge() {
  return (
    <Badge variant="outline" className="border-dashed border-foreground/50">
      Internal
    </Badge>
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
}: {
  number: number;
  item: InternalItem;
  internal: boolean;
  /** What the item is called, for the menu's accessible name and the confirmation. */
  label: string;
  canMark: boolean;
}) {
  const mark = useMarkInternal(number);
  const guests = useGuests(number, canMark);
  const [confirming, setConfirming] = useState(false);
  /** Guests whose access hasn't expired: the people who would see it. */
  const active = (guests.data ?? []).filter((g) => !g.expired).map((g) => g.guest.name);

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
  if (!canMark) return state;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
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
