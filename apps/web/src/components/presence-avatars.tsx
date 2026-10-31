import { useCasePresence } from "@/lib/live";

const tints = ["bg-sky-200", "bg-amber-200", "bg-emerald-200", "bg-rose-200", "bg-violet-200", "bg-lime-200"];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

const tintFor = (id: string) => tints[[...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % tints.length];

/** "Viewing now": who has Case `number` open, live. */
export function PresenceAvatars({ number }: { number: number }) {
  const viewers = useCasePresence(number);
  if (!viewers.length) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Viewing now</span>
      <ul className="flex -space-x-1.5" aria-label="Viewing now">
        {viewers.map((v) => (
          <li
            key={v.id}
            title={v.name}
            aria-label={v.name}
            className={`flex size-7 items-center justify-center rounded-full border-2 border-background text-[11px] font-semibold text-slate-900 ${tintFor(v.id)}`}
          >
            <span aria-hidden>{initials(v.name)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
