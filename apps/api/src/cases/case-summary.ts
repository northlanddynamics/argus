import { z } from "zod";

/**
 * The Case Summary's rich text: a ProseMirror document limited to paragraphs, headings,
 * bullet lists, bold, italic and links. Stored as this JSON, never as HTML, so it can't carry markup
 * or script; unknown attributes are dropped.
 */

const href = z
  .string()
  .max(2048)
  .refine((value) => /^(https?:|mailto:)/i.test(value), "Links must be http, https or mailto");

const mark = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }),
  z.object({ type: z.literal("italic") }),
  z.object({ type: z.literal("link"), attrs: z.object({ href }) }),
]);

const inline = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1), marks: z.array(mark).optional() }),
  z.object({ type: z.literal("hardBreak") }),
]);

const paragraph = z.object({ type: z.literal("paragraph"), content: z.array(inline).optional() });
const heading = z.object({
  type: z.literal("heading"),
  attrs: z.object({ level: z.union([z.literal(2), z.literal(3)]) }),
  content: z.array(inline).optional(),
});

type ListItem = { type: "listItem"; content: (z.infer<typeof paragraph> | BulletList)[] };
type BulletList = { type: "bulletList"; content: ListItem[] };

const listItem: z.ZodType<ListItem> = z.lazy(() =>
  z.object({ type: z.literal("listItem"), content: z.array(z.union([paragraph, bulletList])).min(1) }),
);
const bulletList: z.ZodType<BulletList> = z.lazy(() =>
  z.object({ type: z.literal("bulletList"), content: z.array(listItem).min(1) }),
);

/** Keeps a summary to a size the page and the Audit Log can carry. */
const MAX_JSON_LENGTH = 200_000;

export const caseSummarySchema = z
  .object({ type: z.literal("doc"), content: z.array(z.union([paragraph, heading, bulletList])) })
  .refine((doc) => JSON.stringify(doc).length <= MAX_JSON_LENGTH, "The Case Summary is too long");

export type CaseSummary = z.infer<typeof caseSummarySchema>;

export const emptySummary = (): CaseSummary => ({ type: "doc", content: [] });
