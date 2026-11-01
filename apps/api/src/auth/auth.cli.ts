// Entry point for the Better Auth CLI only (`bun run auth:generate`).
import { systemClock } from "../clock";
import { createDb } from "../db/client";
import { consoleMailer } from "../mail";
import { createAuth } from "./auth";

export const auth = createAuth({
  db: createDb(process.env.DATABASE_URL ?? "postgres://localhost/argus").db,
  baseUrl: "http://localhost:3000",
  secret: "cli-only-secret-cli-only-secret-00",
  mailer: consoleMailer,
  clock: systemClock,
});
