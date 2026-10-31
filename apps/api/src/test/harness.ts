import { passkeyClient } from "@better-auth/passkey/client";
import { websocket } from "@hono/bun";
import { createAuthClient } from "better-auth/client";
import { adminClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createApi } from "../app";
import { createAuth } from "../auth/auth";
import { OPERATOR_ROLE } from "../auth/roles";
import { createApiClient } from "../client";
import { createDb } from "../db/client";
import { fakeClock } from "../clock";
import type { Deps } from "../deps";
import { captureOutbox } from "../mail";
import { createLive } from "../realtime/live";
import { type ClientMessage, LIVE_PATH, type ServerMessage } from "../realtime/messages";
import { postgresSignals } from "../realtime/signals";
import { createTestDb } from "./db";

/**
 * Reads the secret out of an `otpauth://` URI, decoded from base32 back to the raw
 * string Better Auth generated (what `generateTOTP` expects).
 */
export const totpSecret = (totpURI: string) => {
  const encoded = new URL(totpURI).searchParams.get("secret");
  if (!encoded) throw new Error(`No secret in ${totpURI}`);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of encoded.replace(/=+$/, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2));
  return new TextDecoder().decode(new Uint8Array(bytes));
};

const cleanups: (() => Promise<void>)[] = [];

/** Drops every test database made since the last call. `test/setup.ts` runs it after each test, in every file. */
export async function cleanUpTestApps() {
  while (cleanups.length) await cleanups.pop()!();
}

/**
 * Builds the API in-process against a fresh Postgres database, with a fake clock
 * and a captured mail outbox. Drive it through `session()`s, and watch it through `connect(...)`.
 */
export async function buildTestApp({ baseUrl = "http://argus.test" }: { baseUrl?: string } = {}) {
  const BASE_URL = baseUrl;
  const { db, sql, url, drop } = await createTestDb();
  cleanups.push(drop);
  const clock = fakeClock();
  const outbox = captureOutbox();
  const authSecret = "test-secret-test-secret-test-secret";
  const auth = createAuth({ db, baseUrl: BASE_URL, secret: authSecret });
  const deps: Deps = { db, auth, clock, mailer: outbox.mailer, signals: postgresSignals(sql), baseUrl: BASE_URL };

  /**
   * One `web` process: the API with its own live hub, listening on a real port for live sockets.
   * `deps` decides what it shares with the others.
   */
  const startInstance = async (instanceDeps: Deps) => {
    const live = createLive(instanceDeps);
    const app = createApi(instanceDeps, live);
    await live.ready;
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    cleanups.push(async () => {
      await server.stop(true);
      await live.close();
    });
    const liveUrl = `ws://${server.hostname}:${server.port}${LIVE_PATH}`;

    /**
     * Opens `as`'s live socket to this instance and collects what it receives.
     * Rejects when the handshake is refused (signed out, not a Member, wrong origin).
     */
    const connect = async (as: { cookieHeader: () => string }, { origin = BASE_URL }: { origin?: string } = {}) => {
      const ws = new WebSocket(liveUrl, { headers: { cookie: as.cookieHeader(), origin } });
      const messages: ServerMessage[] = [];
      let cursor = 0;
      let wake: (() => void) | undefined;
      ws.addEventListener("message", (e) => {
        messages.push(JSON.parse(String(e.data)) as ServerMessage);
        wake?.();
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.addEventListener("close", (e) => {
          resolve({ code: e.code, reason: e.reason });
          wake?.();
        }),
      );
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("The live socket was refused")));
      });
      cleanups.push(async () => ws.close());
      return {
        /** Everything received so far. */
        messages,
        /** How the socket closed, once it has. */
        closed,
        send: (message: ClientMessage) => ws.send(JSON.stringify(message)),
        /**
         * The next message, after the last one this returned, that `match` accepts; earlier
         * ones it skips stay in `messages`. Fails after `ms`.
         */
        async next(match: (m: ServerMessage) => boolean = () => true, ms = 3000) {
          const deadline = Date.now() + ms;
          for (;;) {
            while (cursor < messages.length) {
              const m = messages[cursor++]!;
              if (match(m)) return m;
            }
            if (ws.readyState === WebSocket.CLOSED) throw new Error("The live socket closed");
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`No matching live message; received ${JSON.stringify(messages)}`);
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, left);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          }
        },
        close: async () => {
          ws.close();
          await closed;
        },
      };
    };
    return { app, live, liveUrl, connect };
  };

  const first = await startInstance(deps);
  const { app, live } = first;

  /**
   * Another `web` process on the same database, with its own connections, so signals reach it only
   * through Postgres. Sessions from `session()` are valid on it.
   */
  const anotherInstance = async () => {
    const other = createDb(url);
    cleanups.push(other.close);
    const otherAuth = createAuth({ db: other.db, baseUrl: BASE_URL, secret: authSecret });
    return startInstance({ ...deps, db: other.db, auth: otherAuth, signals: postgresSignals(other.sql) });
  };

  /** A browser-like session: its own cookie jar, the RPC client and the Better Auth client. */
  const session = () => {
    const cookies = new Map<string, string>();
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      request.headers.set("origin", BASE_URL);
      if (cookies.size) {
        request.headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      }
      const response = await app.request(request);
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        const index = pair!.indexOf("=");
        const key = pair!.slice(0, index);
        const value = pair!.slice(index + 1);
        if (value === "" || /max-age=0/i.test(header)) cookies.delete(key);
        else cookies.set(key, value);
      }
      return response;
    };
    const api = createApiClient(BASE_URL, { fetch }).api;
    const authClient = createAuthClient({
      baseURL: `${BASE_URL}/api/auth`,
      fetchOptions: { customFetchImpl: fetch },
      plugins: [adminClient(), organizationClient(), twoFactorClient(), passkeyClient()],
    });
    /** Email and password only; a Member enrolled in TOTP gets `twoFactorRedirect` and no session yet. */
    const signIn = async (email: string, password: string) => {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) throw new Error(`Sign-in failed for ${email}: ${result.error.message}`);
      return result.data;
    };
    /** Enrolls the signed-in Member in TOTP and confirms it with a code from their new secret. */
    const enrollTotp = async (password: string) => {
      const enabled = await authClient.twoFactor.enable({ password });
      if (enabled.error || enabled.data.method !== "totp") throw new Error(`Could not enable TOTP: ${enabled.error?.message}`);
      const secret = totpSecret(enabled.data.totpURI);
      const verified = await authClient.twoFactor.verifyTotp({ code: await totpCode(secret) });
      if (verified.error) throw new Error(`Could not confirm TOTP: ${verified.error.message}`);
      return { secret, backupCodes: enabled.data.backupCodes };
    };
    /** The session's cookies, as a browser would send them. */
    const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return { api, auth: authClient, signIn, enrollTotp, cookieHeader };
  };

  /** The current code for a TOTP secret, as the Member's authenticator app shows it. */
  const totpCode = async (secret: string) => (await auth.api.generateTOTP({ body: { secret } })).code;

  /** Accepts the latest invite sent to `email`, signs in and enrolls in TOTP: a Member as they are after their first sign-in. */
  const acceptInvite = async (email: string, password: string, name = "Olive Owner") => {
    const s = session();
    const res = await s.api.invitations[":id"].accept.$post({ param: { id: inviteIdFor(email) }, json: { name, password } });
    if (res.status !== 200) throw new Error(`Could not accept invite for ${email}: ${res.status}`);
    await s.signIn(email, password);
    const totp = await s.enrollTotp(password);
    return { ...s, totp };
  };

  /** Creates an Operator directly, the way `bun run operator:create` does. */
  const createOperator = async (email = "ops@argus.test", password = "operator-password-1") => {
    const existing = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, email) });
    if (!existing) await auth.api.createUser({ body: { email, password, name: "Ops", role: OPERATOR_ROLE } });
    const s = session();
    await s.signIn(email, password);
    return s;
  };

  /** Pulls the invitation id out of the latest invite email sent to `email`. */
  const inviteIdFor = (email: string) => {
    const message = outbox.messages.findLast((m) => m.to === email);
    const id = message?.text.match(/\/invite\/([\w-]+)/)?.[1];
    if (!id) throw new Error(`No invite email for ${email}`);
    return id;
  };

  /** Creates an Organization through the Operator API and returns the Owner's invite link. */
  const inviteOwner = async (name: string, ownerEmail: string) => {
    const operator = await createOperator();
    const res = await operator.api.operator.organizations.$post({ json: { name, ownerEmail } });
    if (res.status !== 201) throw new Error(`Could not create ${name}: ${res.status}`);
    return `${BASE_URL}/invite/${inviteIdFor(ownerEmail)}`;
  };

  return {
    app,
    deps,
    clock,
    outbox,
    live,
    /** Opens a live socket to the first instance; see `startInstance`. */
    connect: first.connect,
    anotherInstance,
    session,
    createOperator,
    inviteIdFor,
    inviteOwner,
    acceptInvite,
    totpCode,
  };
}
