import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Under the Case's key, so its live signal refreshes them. */
export const discussionKey = (number: number) => ["cases", number, "discussion"] as const;
export const mentionableKey = (number: number) => ["cases", number, "discussion", "mentionable"] as const;

export const discussionQuery = (number: number) =>
  queryOptions({
    queryKey: discussionKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].discussion.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Discussion");
      return (await res.json()).messages;
    },
  });

/** The people who can see the Case, and so can be mentioned on it. */
export const mentionableQuery = (number: number) =>
  queryOptions({
    queryKey: mentionableKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].discussion.mentionable.$get({ param: { number: String(number) } });
      if (!res.ok) throw new Error("Could not load who can be mentioned");
      const body = await res.json();
      return "people" in body ? body.people : [];
    },
  });

export type MessageView = NonNullable<Awaited<ReturnType<ReturnType<typeof discussionQuery>["queryFn"] & {}>>>[number];
export type Person = { id: string; name: string };

/** How a message's text stores a mention: `<@userId>`. */
const MENTION = /<@([A-Za-z0-9_-]{1,64})>/g;

/** A message's text as alternating plain text and mentioned people, for display. */
export function messageParts(body: string, mentions: readonly Person[]): (string | Person)[] {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  return body.split(MENTION).map((part, i) => (i % 2 === 1 ? { id: part, name: names.get(part) ?? "unknown" } : part));
}

/** A message's text as it is typed: each mention as "@Name". */
export const typedText = (body: string, mentions: readonly Person[]) =>
  messageParts(body, mentions)
    .map((part) => (typeof part === "string" ? part : `@${part.name}`))
    .join("");

/** Typed text back into a message's text, turning "@Name" into a mention for each person picked. */
export function messageBody(typed: string, picked: readonly Person[]) {
  let body = typed;
  // Longest names first, so "@Ana Analyst-Smith" isn't taken for "@Ana Analyst".
  for (const p of picked.toSorted((a, b) => b.name.length - a.name.length)) body = body.replaceAll(`@${p.name}`, `<@${p.id}>`);
  return body;
}
