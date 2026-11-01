import type { FalconCloud } from "../alerts/vocabulary";
import type { FalconClient, FalconConnection, StreamEvent, StreamSession } from "./falcon";

/**
 * The Falcon API over HTTP: OAuth2 client credentials, then the Event Streams discovery, refresh and
 * data feed endpoints. Unverified against a live tenant (see spec #1, "Further Notes").
 */

const BASE_URLS: Record<FalconCloud, string> = {
  "us-1": "https://api.crowdstrike.com",
  "us-2": "https://api.us-2.crowdstrike.com",
  "eu-1": "https://api.eu-1.crowdstrike.com",
  "us-gov-1": "https://api.laggar.gcw.crowdstrike.com",
};

/** Falcon's default when a session says nothing: 30 minutes. */
const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60_000;

/** A Falcon API call failed; the message says which and how. */
export class FalconError extends Error {}

async function failure(what: string, res: Response) {
  let detail = "";
  try {
    const body = (await res.json()) as { errors?: { message?: string }[] };
    detail = body.errors?.map((e) => e.message).filter(Boolean).join("; ") ?? "";
  } catch {
    // Not JSON: the status says enough.
  }
  return new FalconError(`${what} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
}

export function falconHttpClient({ cloud, credentials, appId }: FalconConnection, fetchImpl: typeof fetch = fetch): FalconClient {
  const base = BASE_URLS[cloud];
  let token: { value: string; expiresAt: number } | null = null;

  const accessToken = async () => {
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const res = await fetchImpl(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret }),
    });
    if (!res.ok) throw await failure("Signing in to the Falcon API", res);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  };

  return {
    async openStream() {
      const url = `${base}/sensors/entities/datafeed/v2?${new URLSearchParams({ appId, format: "json" })}`;
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" } });
      if (!res.ok) throw await failure("Opening the Event Stream", res);
      const body = (await res.json()) as {
        resources?: {
          dataFeedURL: string;
          sessionToken: { token: string };
          refreshActiveSessionURL: string;
          refreshActiveSessionInterval?: number;
        }[];
      };
      const stream = body.resources?.[0];
      if (!stream) throw new FalconError("Falcon offered no Event Stream: is Event Streams enabled for this subscription?");
      return {
        dataFeedUrl: stream.dataFeedURL,
        token: stream.sessionToken.token,
        refreshUrl: stream.refreshActiveSessionURL,
        refreshIntervalMs: stream.refreshActiveSessionInterval ? stream.refreshActiveSessionInterval * 1000 : DEFAULT_REFRESH_INTERVAL_MS,
      } satisfies StreamSession;
    },

    async refreshStream(session) {
      const res = await fetchImpl(session.refreshUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action_name: "refresh_active_stream_session", appId }),
      });
      if (!res.ok) throw await failure("Refreshing the Event Stream session", res);
    },

    async *consume(session, offset, signal) {
      const url = new URL(session.dataFeedUrl);
      url.searchParams.set("offset", String(offset));
      const res = await fetchImpl(url, { headers: { authorization: `Token ${session.token}`, accept: "application/json" }, signal });
      if (!res.ok || !res.body) throw await failure("Reading the Event Stream", res);
      // Newline-delimited JSON; blank lines are keep-alives.
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of res.body) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) yield parseEvent(line);
        }
      }
    },
  };
}

function parseEvent(line: string): StreamEvent {
  const parsed = JSON.parse(line) as {
    metadata: { offset: number; eventType: string; eventCreationTime?: number };
    event?: Record<string, unknown>;
  };
  const { offset, eventType, eventCreationTime } = parsed.metadata;
  return { offset, eventType, createdAt: eventCreationTime ? new Date(eventCreationTime) : null, event: parsed.event ?? {} };
}
