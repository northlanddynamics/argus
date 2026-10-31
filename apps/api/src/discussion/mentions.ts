/**
 * Mentions in a Discussion message's text. The text stores a mention as `<@userId>`, so it stays
 * right when the person is renamed; clients show it as "@Name".
 */

const MENTION = /<@([A-Za-z0-9_-]{1,64})>/g;

/** The people `text` mentions, once each, in the order first mentioned. */
export const mentionedIds = (text: string) => [...new Set(Array.from(text.matchAll(MENTION), (m) => m[1]!))];

/** `text` with each mention written as "@Name", as the Audit Log records it; "@unknown" for nobody. */
export const withNames = (text: string, names: ReadonlyMap<string, string>) =>
  text.replace(MENTION, (_, id: string) => `@${names.get(id) ?? "unknown"}`);
