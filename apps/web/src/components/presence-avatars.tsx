import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCasePresence } from "@/lib/live";

const tints = ["sky", "amber", "emerald", "rose", "violet", "lime"] as const;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** The same tint for the same person, in every view. */
export const tintFor = (id: string) => tints[[...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % tints.length];

/** A small avatar for a person named in a list: their initials on their tint. */
export function PersonAvatar({ person }: { person: { id: string | null; name: string } }) {
  return (
    <Avatar size="xs" aria-hidden>
      <AvatarFallback tint={tintFor(person.id ?? person.name)}>{initials(person.name)}</AvatarFallback>
    </Avatar>
  );
}

/** "Viewing now": who has Case `number` open, live. */
export function PresenceAvatars({ number }: { number: number }) {
  const viewers = useCasePresence(number);
  if (!viewers.length) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Viewing now</span>
      <AvatarGroup role="list" aria-label="Viewing now">
        {viewers.map((v) => (
          <Tooltip key={v.id}>
            <TooltipTrigger asChild>
              <Avatar role="listitem" aria-label={v.name} tabIndex={0}>
                <AvatarFallback tint={tintFor(v.id)} aria-hidden>
                  {initials(v.name)}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent>{v.name}</TooltipContent>
          </Tooltip>
        ))}
      </AvatarGroup>
    </div>
  );
}
