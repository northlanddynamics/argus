import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(url: string) {
  const sql = postgres(url, { onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof createDb>["db"];

/** A transaction handle from `db.transaction`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
