/**
 * The kinds of Case Link (GLOSSARY.md). Shared with the SPA, so plain values only.
 *
 * A link is stored once, from one Case to the other, as one of `STORED_LINK_TYPES`; "Child of" is
 * stored as the other Case being "Parent of" this one. Each Case reads the link from its own side.
 */

/** What a Member picks when linking this Case to another. */
export const LINK_TYPES = ["related", "duplicate_of", "parent_of", "child_of"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** How a link is stored, from `source` to `target`. */
export const STORED_LINK_TYPES = ["related", "duplicate_of", "parent_of"] as const;
export type StoredLinkType = (typeof STORED_LINK_TYPES)[number];

/** How a link reads from one of its two Cases. */
export const LINK_SIDES = ["related", "duplicate_of", "duplicated_by", "parent_of", "child_of"] as const;
export type LinkSide = (typeof LINK_SIDES)[number];

export const linkSideLabel: Record<LinkSide, string> = {
  related: "Related",
  duplicate_of: "Duplicate of",
  duplicated_by: "Duplicated by",
  parent_of: "Parent of",
  child_of: "Child of",
};

/** The link as stored, for a Member linking `from` to another Case with `type`. */
export function storedLink(type: LinkType): { type: StoredLinkType; fromIsSource: boolean } {
  if (type === "child_of") return { type: "parent_of", fromIsSource: false };
  return { type, fromIsSource: true };
}

/** How a stored link reads from its source Case (`isSource`) or its target. */
export function sideOf(type: StoredLinkType, isSource: boolean): LinkSide {
  if (type === "related") return "related";
  if (type === "duplicate_of") return isSource ? "duplicate_of" : "duplicated_by";
  return isSource ? "parent_of" : "child_of";
}
