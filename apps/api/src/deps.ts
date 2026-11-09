import type { Auth } from "./auth/auth";
import type { Clock } from "./clock";
import type { Db } from "./db/client";
import type { EvidenceStorage } from "./evidence/storage";
import type { GuestSession } from "./guests/guest-sessions";
import type { CredentialSealer } from "./integrations/credentials";
import type { IpinfoConnector } from "./ipinfo/ipinfo";
import type { UmbrellaConnector } from "./umbrella/umbrella";
import type { VirustotalConnector } from "./virustotal/virustotal";
import type { Mailer } from "./mail";
import type { SignalSource } from "./realtime/signals";
import type { TeamsPoster } from "./teams/teams-webhook";

/** Everything the app reaches outside itself; injected so tests can swap in fakes. */
export type Deps = {
  db: Db;
  auth: Auth;
  mailer: Mailer;
  /** Posts to Organizations' Teams channels. */
  teams: TeamsPoster;
  clock: Clock;
  /** Change signals from every process (ADR 0005). */
  signals: SignalSource;
  /** Public origin of the app, used in links sent by email. */
  baseUrl: string;
  /** Where Evidence files are kept, and the largest file accepted. */
  evidence: EvidenceConfig;
  /** Seals Integration credentials at rest. */
  credentials: CredentialSealer;
  /** Makes IPinfo clients, to look IPs up while a Member waits (ADR 0010). */
  ipinfo: IpinfoConnector;
  /** Makes VirusTotal clients, one per Member's key, to look hashes, domains and URLs up while they wait (ADR 0011, 0012). */
  virustotal: VirustotalConnector;
  /** Makes Cisco Umbrella clients, to list destination lists and check domains against them while a Member waits (ADR 0014). */
  umbrella: UmbrellaConnector;
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
