/** The kinds of item on a Case that can be marked Internal, hiding them from the Case's Guests. */
export const INTERNAL_ITEM_KINDS = ["task", "discussion_message", "timeline_entry", "evidence", "alert"] as const;
export type InternalItemKind = (typeof INTERNAL_ITEM_KINDS)[number];
export type InternalItem = { kind: InternalItemKind; id: string };
