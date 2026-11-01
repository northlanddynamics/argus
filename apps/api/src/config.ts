import { fileURLToPath } from "node:url";
import { S3Client } from "bun";
import { createAuth } from "./auth/auth";
import { systemClock } from "./clock";
import { createDb } from "./db/client";
import type { Deps, EvidenceConfig } from "./deps";
import { s3EvidenceStorage } from "./evidence/s3-storage";
import { credentialSealer } from "./integrations/credentials";
import { unconfiguredEvidenceStorage } from "./evidence/storage";
import { consoleMailer, smtpMailer } from "./mail";
import { postgresSignals } from "./realtime/signals";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

/** The largest Evidence file accepted unless `EVIDENCE_MAX_BYTES` says otherwise: 64 GiB, room for a memory image. */
const DEFAULT_EVIDENCE_MAX_BYTES = 64 * 1024 ** 3;

/**
 * Evidence in the S3 bucket `S3_BUCKET`. Bun's S3 client reads `S3_ENDPOINT`, `S3_REGION`,
 * `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (or the AWS_ equivalents) itself.
 */
function evidenceFromEnv(): EvidenceConfig {
  const maxBytes = Number(process.env.EVIDENCE_MAX_BYTES ?? DEFAULT_EVIDENCE_MAX_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("EVIDENCE_MAX_BYTES must be a positive whole number");
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    console.warn("S3_BUCKET is not set: adding, viewing and downloading Evidence will fail");
    return { storage: unconfiguredEvidenceStorage, maxBytes };
  }
  return { storage: s3EvidenceStorage(new S3Client({ bucket })), maxBytes };
}

/** Production dependencies, read from the environment. */
export function depsFromEnv(): Deps & { close: () => Promise<void> } {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const { db, sql, close } = createDb(required("DATABASE_URL"));
  const mailer = process.env.SMTP_URL
    ? smtpMailer(process.env.SMTP_URL, process.env.MAIL_FROM ?? "Argus <no-reply@argus.local>")
    : consoleMailer;
  const authSecret = required("BETTER_AUTH_SECRET");
  const auth = createAuth({ db, baseUrl, secret: authSecret, mailer, clock: systemClock });
  return {
    db,
    auth,
    mailer,
    clock: systemClock,
    signals: postgresSignals(sql),
    baseUrl,
    evidence: evidenceFromEnv(),
    // Integration credentials are sealed under their own secret when one is set.
    credentials: credentialSealer(process.env.CREDENTIALS_SECRET ?? authSecret),
    close,
  };
}

export const defaultWebDist =
  process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
