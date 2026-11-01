import { and, count, eq, sql } from "drizzle-orm";
import { type Actor, visibleItems } from "../access/policy";
import type { Db } from "../db/client";
import { tasks } from "../db/schema";

/** How many Tasks on a Case `actor` can see, and how many of them are done. */
export async function taskCounts(db: Db, caseId: string, actor: Actor) {
  const [row] = await db
    .select({ total: count(), done: sql<number>`count(*) filter (where ${tasks.done})::int` })
    .from(tasks)
    .where(and(eq(tasks.caseId, caseId), visibleItems(actor, tasks.internal)));
  return { total: row?.total ?? 0, done: row?.done ?? 0 };
}
