/**
 * The Teams adapter: posts a message to a Teams channel through its incoming webhook (a Teams
 * Workflows "post to a channel when a webhook request is received" URL, or a legacy connector URL).
 * Both take an Adaptive Card in a `message` envelope.
 */

/** A channel post, before it is rendered as an Adaptive Card. */
export type TeamsMessage = {
  /** What happened, in a line. */
  heading: string;
  /** The Case, as "C-12 · Title"; left out for Restricted Cases. */
  text?: string;
  /** Label and value pairs; empty for Restricted Cases. */
  facts: { title: string; value: string }[];
  link: { title: string; url: string };
};

export interface TeamsPoster {
  /** Posts `message` to the channel behind `webhookUrl`; throws when it isn't accepted. */
  post(webhookUrl: string, message: TeamsMessage): Promise<void>;
}

/** The webhook's JSON body: `message` as an Adaptive Card. */
export const adaptiveCard = (message: TeamsMessage) => ({
  type: "message",
  attachments: [
    {
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: "Argus", size: "Small", weight: "Bolder", isSubtle: true },
          { type: "TextBlock", text: message.heading, size: "Medium", weight: "Bolder", wrap: true },
          ...(message.text ? [{ type: "TextBlock", text: message.text, wrap: true }] : []),
          ...(message.facts.length ? [{ type: "FactSet", facts: message.facts }] : []),
        ],
        actions: [{ type: "Action.OpenUrl", title: message.link.title, url: message.link.url }],
      },
    },
  ],
});

const TIMEOUT_MS = 10_000;

/** Posts over HTTPS. Redirects are not followed: the URL Admins saved is the only one posted to. */
export const httpTeamsPoster: TeamsPoster = {
  async post(webhookUrl, message) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adaptiveCard(message)),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Teams answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  },
};

/** Captures posts in memory; tests read `posts`, and make the next ones fail with `failNext`. */
export function captureTeams() {
  const posts: { webhookUrl: string; message: TeamsMessage }[] = [];
  let failures = 0;
  const poster: TeamsPoster = {
    async post(webhookUrl, message) {
      if (failures > 0) {
        failures--;
        throw new Error("Teams answered 503 Service Unavailable");
      }
      posts.push({ webhookUrl, message });
    },
  };
  return {
    poster,
    posts,
    /** Fails the next `n` posts. */
    failNext(n = 1) {
      failures = n;
    },
  };
}
