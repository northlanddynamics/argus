import { inArray } from "drizzle-orm";
import type { Tx } from "../db/client";
import { session } from "../db/schema";

/** Ends every session these people hold, so a change to their membership takes effect now. Joins `tx`. */
export const signOutEverywhere = (tx: Tx, userIds: string[]) =>
  userIds.length ? tx.delete(session).where(inArray(session.userId, userIds)) : Promise.resolve();
