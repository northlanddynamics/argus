// Entry point for the Better Auth CLI only (`bun run auth:generate`).
import { createDb } from "../db/client";
import { createAuth } from "./auth";

export const auth = createAuth({
  db: createDb(process.env.DATABASE_URL ?? "postgres://localhost/argus").db,
  baseUrl: "http://localhost:3000",
  secret: "cli-only-secret-cli-only-secret-00",
});
