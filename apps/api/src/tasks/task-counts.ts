import { count, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { tasks } from "../db/schema";

/** How many Tasks a Case has, and how many of them are done. */
export async function taskCounts(db: Db, caseId: string) {
  const [row] = await db
    .select({ total: count(), done: sql<number>`count(*) filter (where ${tasks.done})::int` })
    .from(tasks)
    .where(eq(tasks.caseId, caseId));
  return { total: row?.total ?? 0, done: row?.done ?? 0 };
}
