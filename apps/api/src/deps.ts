import type { Auth } from "./auth/auth";
import type { Clock } from "./clock";
import type { Db } from "./db/client";
import type { EvidenceStorage } from "./evidence/storage";
import type { GuestSession } from "./guests/guest-sessions";
import type { Mailer } from "./mail";
import type { SignalSource } from "./realtime/signals";

/** Everything the app reaches outside itself; injected so tests can swap in fakes. */
export type Deps = {
  db: Db;
  auth: Auth;
  mailer: Mailer;
  clock: Clock;
  /** Change signals from every process (ADR 0005). */
  signals: SignalSource;
  /** Public origin of the app, used in links sent by email. */
  baseUrl: string;
  /** Where Evidence files are kept, and the largest file accepted. */
  evidence: EvidenceConfig;
};

export type EvidenceConfig = { storage: EvidenceStorage; maxBytes: number };

export type SessionUser = Auth["$Infer"]["Session"]["user"];
export type Env = {
  Variables: {
    /** The signed-in person; null when signed out or still awaiting TOTP enrollment. */
    user: SessionUser | null;
    /** Signed in with a password, but TOTP enrollment is not done yet. */
    totpEnrollmentPending: boolean;
    /** The signed-in person's Guest session, when they are a Guest. */
    guestSession: GuestSession | null;
  };
};
