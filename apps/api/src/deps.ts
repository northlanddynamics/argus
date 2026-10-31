import type { Auth } from "./auth/auth";
import type { Clock } from "./clock";
import type { Db } from "./db/client";
import type { Mailer } from "./mail";

/** Everything the app reaches outside itself; injected so tests can swap in fakes. */
export type Deps = {
  db: Db;
  auth: Auth;
  mailer: Mailer;
  clock: Clock;
  /** Public origin of the app, used in links sent by email. */
  baseUrl: string;
};

export type SessionUser = Auth["$Infer"]["Session"]["user"];
export type Env = { Variables: { user: SessionUser | null } };
