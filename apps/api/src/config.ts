import { fileURLToPath } from "node:url";
import { createAuth } from "./auth/auth";
import { systemClock } from "./clock";
import { createDb } from "./db/client";
import type { Deps } from "./deps";
import { consoleMailer, smtpMailer } from "./mail";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

/** Production dependencies, read from the environment. */
export function depsFromEnv(): Deps & { close: () => Promise<void> } {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const { db, close } = createDb(required("DATABASE_URL"));
  const auth = createAuth({ db, baseUrl, secret: required("BETTER_AUTH_SECRET") });
  const mailer = process.env.SMTP_URL
    ? smtpMailer(process.env.SMTP_URL, process.env.MAIL_FROM ?? "Argus <no-reply@argus.local>")
    : consoleMailer;
  return { db, auth, mailer, clock: systemClock, baseUrl, close };
}

export const defaultWebDist =
  process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
