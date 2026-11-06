import { type BlockedSender, type BlockedSenderType, type MimecastClient, type MimecastCredentials, MimecastRefused, type NewBlockedSender } from "./mimecast";

/**
 * The Mimecast API 2.0 over HTTP: OAuth2 client credentials at the global gateway, then the Blocked
 * Senders policy endpoints (`/api/policy/blockedsenders/{get,create,delete}-policy`). Unverified
 * against a live account.
 */

const BASE_URL = "https://api.services.mimecast.com";

/** How long a call may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many entries to read per page when looking one up. */
const PAGE_SIZE = 500;

/** A Mimecast API call failed; the message says which and how. */
export class MimecastError extends Error {}

/** Mimecast's policy `from` for an entry. */
const fromOf = (type: BlockedSenderType, value: string) =>
  type === "email" ? { type: "individual_email_address", emailAddress: value } : { type: "email_domain", emailDomain: value };

/** `entry` as the create-policy endpoint takes it: blocking the sender for everyone in the Organization. */
export const blockedSenderBody = (entry: NewBlockedSender) => ({
  data: [
    {
      option: "block_sender",
      policy: {
        description: entry.description,
        fromPart: "both",
        from: fromOf(entry.type, entry.value),
        to: { type: entry.appliesTo },
      },
    },
  ],
});

/** A Blocked Senders policy as Mimecast returns it, if it blocks one address or one domain for everyone. */
export function readBlockedSender(r: Record<string, unknown>): BlockedSender | null {
  const policy = r.policy as { description?: unknown; from?: Record<string, unknown>; to?: Record<string, unknown> } | undefined;
  if (typeof r.id !== "string" || !policy?.from) return null;
  const description = typeof policy.description === "string" ? policy.description : "";
  if (policy.to?.type !== "everyone") return null;
  const { type, emailAddress, emailDomain } = policy.from;
  if (type === "individual_email_address" && typeof emailAddress === "string") {
    return { id: r.id, type: "email", value: emailAddress.toLowerCase(), appliesTo: "everyone", description };
  }
  if (type === "email_domain" && typeof emailDomain === "string") {
    return { id: r.id, type: "domain", value: emailDomain.toLowerCase(), appliesTo: "everyone", description };
  }
  return null;
}

type Envelope = {
  meta?: { status?: number; pagination?: { next?: string } };
  data?: Record<string, unknown>[];
  fail?: { errors?: { code?: string; message?: string }[] }[];
};

const errorsOf = (body: Envelope) => (body.fail ?? []).flatMap((f) => f.errors ?? []);

async function failure(what: string, res: Response) {
  let detail = "";
  try {
    const body = (await res.json()) as Envelope & { error_description?: string };
    detail = errorsOf(body).map((e) => e.message ?? e.code).filter(Boolean).join("; ") || (body.error_description ?? "");
  } catch {
    // Not JSON: the status says enough.
  }
  return `${what} failed: ${res.status}${detail ? ` ${detail}` : ""}`;
}

export function mimecastHttpClient(credentials: MimecastCredentials, fetchImpl: typeof fetch = fetch): MimecastClient {
  let token: { value: string; expiresAt: number } | null = null;

  const accessToken = async () => {
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const res = await fetchImpl(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new MimecastRefused(await failure("Signing in to the Mimecast API", res));
    if (!res.ok) throw new MimecastError(await failure("Signing in to the Mimecast API", res));
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  };

  /** POSTs `body` to `path`; resolves to Mimecast's envelope, or rejects with what went wrong. */
  const call = async (what: string, path: string, body: unknown, { notFound = false } = {}) => {
    const res = await fetchImpl(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (notFound && res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new MimecastRefused(await failure(what, res));
    if (!res.ok) throw new MimecastError(await failure(what, res));
    const envelope = (await res.json()) as Envelope;
    const errors = errorsOf(envelope);
    if (errors.length) {
      if (notFound && errors.every((e) => /not.?found/i.test(`${e.code ?? ""} ${e.message ?? ""}`))) return null;
      throw new MimecastError(`${what} failed: ${errors.map((e) => e.message ?? e.code).join("; ")}`);
    }
    return envelope;
  };

  return {
    async check() {
      token = null;
      await accessToken();
    },

    async findBlockedSender(type, value) {
      let pageToken: string | undefined;
      for (let page = 0; page < 100; page++) {
        const body = await call("Looking up a blocked sender in Mimecast", "/api/policy/blockedsenders/get-policy", {
          meta: { pagination: { pageSize: PAGE_SIZE, ...(pageToken && { pageToken }) } },
          data: [],
        });
        for (const r of body?.data ?? []) {
          const found = readBlockedSender(r);
          if (found?.type === type && found.value === value.toLowerCase()) return found;
        }
        pageToken = body?.meta?.pagination?.next;
        if (!pageToken) return null;
      }
      return null;
    },

    async blockSender(entry) {
      const body = await call("Blocking a sender in Mimecast", "/api/policy/blockedsenders/create-policy", blockedSenderBody(entry));
      const id = body?.data?.[0]?.id;
      if (typeof id !== "string") throw new MimecastError("Blocking a sender in Mimecast failed: Mimecast returned no policy");
      return id;
    },

    async deleteBlockedSender(id) {
      const body = await call("Removing a blocked sender from Mimecast", "/api/policy/blockedsenders/delete-policy", { data: [{ id }] }, { notFound: true });
      return body !== null;
    },
  };
}
