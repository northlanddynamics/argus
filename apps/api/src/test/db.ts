import postgres from "postgres";
import { createDb } from "../db/client";
import { runMigrations } from "../db/migrate";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const TEMPLATE = "argus_test_template";

const urlFor = (database: string) => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
};

let template: Promise<void> | undefined;

/** Builds a migrated template database once per test process. */
function ensureTemplate() {
  template ??= (async () => {
    const admin = postgres(ADMIN_URL, { onnotice: () => {} });
    // Clear databases left behind by earlier runs (crashed or interrupted) and rebuild the template.
    const stale = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE 'argus_test_%'`;
    for (const { datname } of stale) await admin.unsafe(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
    await admin.end();
    const { db, close } = createDb(urlFor(TEMPLATE));
    await runMigrations(db);
    await close();
  })();
  return template;
}

/** A fresh, migrated, isolated Postgres database for one test. */
export async function createTestDb() {
  await ensureTemplate();
  const name = `argus_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  const { db, close } = createDb(urlFor(name));
  return {
    db,
    async drop() {
      await close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
