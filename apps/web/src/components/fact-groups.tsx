import type { CSSProperties, ReactNode } from "react";

/** One thing an Integration reported; `value` is null (or empty) when it reported nothing for it. */
export type Fact = { label: string; value: ReactNode };
export type FactGroup = { label: string; facts: Fact[] };

/** The values given, joined by `by`; null when none was given. */
export const joined = (values: readonly (string | null)[], by: string) => values.filter(Boolean).join(by) || null;

const reported = (value: ReactNode) => value !== null && value !== undefined && value !== false && value !== "";

/**
 * Facts in labelled groups, side by side as width allows: one column on a phone, two at medium width,
 * every group in its own column on a wide screen. A fact with no value is left out of its group, and a
 * group with none at all is left out, and they're named once at the foot ("Not reported by Falcon: …").
 */
export function FactGroups({ groups, source }: { groups: FactGroup[]; source: string }) {
  const shown = groups.map((g) => ({ ...g, facts: g.facts.filter((f) => reported(f.value)) })).filter((g) => g.facts.length > 0);
  const missing = groups.flatMap((g) => g.facts.filter((f) => !reported(f.value)).map((f) => f.label));
  return (
    <div className="@container grid gap-2">
      <div
        className="grid grid-cols-1 gap-x-6 gap-y-3 @lg:grid-cols-2 @4xl:grid-cols-[repeat(var(--groups),minmax(0,1fr))]"
        style={{ "--groups": shown.length } as CSSProperties}
      >
        {shown.map((group) => (
          <section key={group.label} aria-label={group.label} className="grid min-w-0 content-start gap-1.5 border-t pt-2">
            <h4 className="text-xs font-medium text-muted-foreground">{group.label}</h4>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {group.facts.map(({ label, value }) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {missing.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not reported by {source}: {missing.join(", ")}
        </p>
      )}
    </div>
  );
}
