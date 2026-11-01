/**
 * How a Tag is written (GLOSSARY.md). Shared with the SPA, so plain functions on strings only.
 *
 * A Tag is stored lowercased, without a leading "#", with spaces turned into hyphens: "#BEC",
 * "bec" and " Bec " are the same Tag. It starts with a letter or digit and is at most 50 characters
 * of letters, digits, "-", "_", "." and ":".
 */

export const TAG_MAX_LENGTH = 50;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u;

/** The Tag as stored, or null if `raw` isn't a valid Tag. */
export function normaliseTag(raw: string): string | null {
  const tag = raw.trim().replace(/^#+/, "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!tag || tag.length > TAG_MAX_LENGTH || !TAG.test(tag)) return null;
  return tag;
}

export const TAG_EXPECTED = `A Tag is letters, digits, "-", "_", "." or ":", up to ${TAG_MAX_LENGTH} characters`;

/** "#bec": how a Tag is shown. */
export const tagLabel = (tag: string) => `#${tag}`;
