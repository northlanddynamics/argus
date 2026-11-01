import { sql, type SQL } from "drizzle-orm";
import { cases, caseTags } from "../db/schema";

/**
 * Conditions and columns on the `cases` table about its Tags, for the Case list and view. Kept apart
 * from `tags.ts`, which builds on `cases/cases.ts`, so the Cases module can use them.
 */

/** A Case's current Tags, alphabetical, as a column of a query on `cases`. */
export const tagsOfCase = sql<string[]>`coalesce((select array_agg(${caseTags.tag} order by ${caseTags.tag}) from ${caseTags} where ${caseTags.caseId} = ${cases.id} and ${caseTags.removedAt} is null), '{}')`;

/** The Case has Tag `tag` (stored form) now. */
export const hasTag = (tag: string): SQL =>
  sql`exists (select 1 from ${caseTags} where ${caseTags.caseId} = ${cases.id} and ${caseTags.tag} = ${tag} and ${caseTags.removedAt} is null)`;
