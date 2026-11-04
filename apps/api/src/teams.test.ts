import { describe, expect, test } from "bun:test";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import { adaptiveCard } from "./teams/teams-webhook";
import { createTeamsSender, MAX_TEAMS_ATTEMPTS } from "./teams/teams";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const WEBHOOK = "https://acme.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/a1b2";
const WORKFLOW = "https://prod-12.westus.logic.azure.com/workflows/9f/triggers/manual/paths/invoke?sig=z9y8";
const param = (number: number) => ({ number: String(number) });
const MINUTE = 60_000;

/** Acme Security: its Owner and Ana (an Analyst), signed in, with helpers to set the channel and work Cases. */
async function acme({ channel = true }: { channel?: boolean } = {}) {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = typeof owner;

  const setWebhook = (webhookUrl: string, as: Session = owner) => as.api["teams-channel"].$put({ json: { webhookUrl } });
  if (channel) {
    const res = await setWebhook(WEBHOOK);
    if (res.status !== 200) throw new Error(`Could not set the Teams channel: ${res.status} ${await res.text()}`);
  }

  const open = async (severity: "high" | "critical", as: Session = ana, title = "Suspicious PowerShell on FIN-LT-0231") => {
    const res = await as.api.cases.$post({ json: { title, caseType: "malware", severity } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };
  type Change = Parameters<Session["api"]["cases"][":number"]["$patch"]>[0]["json"];
  const change = async (number: number, json: Change, as: Session = owner) => {
    const res = await as.api.cases[":number"].$patch({ param: param(number), json });
    if (res.status !== 200) throw new Error(`Could not change the Case: ${res.status} ${await res.text()}`);
  };
  const teamsAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "teams" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries.map((e) => [e.actor.name, e.action, e.before, e.after]);
  };
  const headings = () => t.teams.posts.map((p) => p.message.heading);
  const sender = createTeamsSender(t.deps);

  return { t, owner, ana, setWebhook, open, change, teamsAudit, headings, sender };
}

describe("Configuring the Teams channel webhook", () => {
  test("an Admin sets, replaces and removes it, each recorded in the Organization Audit Log", async () => {
    const { owner, setWebhook, teamsAudit } = await acme({ channel: false });
    expect((await (await owner.api["teams-channel"].$get()).json()).teamsChannel).toEqual({ configured: false, webhook: null });

    expect((await setWebhook(WEBHOOK)).status).toBe(200);
    const set = (await (await owner.api["teams-channel"].$get()).json()).teamsChannel;
    expect(set.configured).toBe(true);
    expect(set.webhook?.hint).toBe("acme.webhook.office.com/…a1b2");
    expect(set.webhook?.updatedBy.name).toBe("Olive Owner");

    expect((await setWebhook(WORKFLOW)).status).toBe(200);
    expect((await owner.api["teams-channel"].$delete()).status).toBe(200);
    expect((await owner.api["teams-channel"].$delete()).status).toBe(404);

    expect(await teamsAudit()).toEqual([
      ["Olive Owner", "teams.webhook_removed", "prod-12.westus.logic.azure.com/…z9y8", null],
      ["Olive Owner", "teams.webhook_changed", "acme.webhook.office.com/…a1b2", "prod-12.westus.logic.azure.com/…z9y8"],
      ["Olive Owner", "teams.webhook_set", null, "acme.webhook.office.com/…a1b2"],
    ]);
  });

  test("the webhook is sealed at rest and never sent back, not even to Admins", async () => {
    const { t, owner } = await acme();
    const body = JSON.stringify(await (await owner.api["teams-channel"].$get()).json());
    expect(body).not.toContain("webhookb2");
    const rows = await t.deps.db.query.teamsChannels.findMany();
    expect(rows[0]!.webhookUrl).not.toContain("webhook.office.com");
  });

  test("Analysts see whether a channel is set, but can't see, set, test or remove its webhook", async () => {
    const { ana, setWebhook, teamsAudit } = await acme();
    expect((await (await ana.api["teams-channel"].$get()).json()).teamsChannel).toEqual({ configured: true, webhook: null });
    expect((await setWebhook(WORKFLOW, ana)).status).toBe(403);
    expect((await ana.api["teams-channel"].test.$post({ json: {} })).status).toBe(403);
    expect((await ana.api["teams-channel"].$delete()).status).toBe(403);
    expect(await teamsAudit()).toHaveLength(1);
  });

  test("only HTTPS Teams webhook URLs are accepted", async () => {
    const { setWebhook, teamsAudit } = await acme({ channel: false });
    for (const url of [
      "not a url",
      "http://acme.webhook.office.com/webhookb2/x",
      "https://example.com/hook",
      "https://webhook.office.com.evil.example/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://user:pw@acme.webhook.office.com/x",
    ]) {
      expect((await setWebhook(url)).status).toBe(400);
    }
    expect(await teamsAudit()).toEqual([]);
  });

  test("a test post goes to the URL given, or to the channel set, and Teams refusing it is reported", async () => {
    const { t, owner } = await acme();
    expect((await owner.api["teams-channel"].test.$post({ json: { webhookUrl: WORKFLOW } })).status).toBe(200);
    expect((await owner.api["teams-channel"].test.$post({ json: {} })).status).toBe(200);
    expect(t.teams.posts.map((p) => [p.webhookUrl, p.message.heading])).toEqual([
      [WORKFLOW, "Argus is connected to this channel"],
      [WEBHOOK, "Argus is connected to this channel"],
    ]);

    t.teams.failNext();
    const failed = await owner.api["teams-channel"].test.$post({ json: {} });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Teams didn't accept the post: Teams answered 503 Service Unavailable" });
  });

  test("with no channel set, a test post needs a URL, and nothing is ever posted", async () => {
    const { t, owner, open } = await acme({ channel: false });
    expect((await owner.api["teams-channel"].test.$post({ json: {} })).status).toBe(404);
    await open("critical");
    expect(t.teams.posts).toEqual([]);
    expect(await t.deps.db.query.teamsPosts.findMany()).toEqual([]);
  });
});

describe("Posts to the channel", () => {
  test("a new Critical Case is posted with its details and a link; other new Cases aren't", async () => {
    const { t, open } = await acme();
    await open("high");
    const number = await open("critical");
    expect(t.teams.posts).toEqual([
      {
        webhookUrl: WEBHOOK,
        message: {
          heading: "New Critical Case opened",
          text: `C-${number} · Suspicious PowerShell on FIN-LT-0231`,
          facts: [
            { title: "Severity", value: "Critical" },
            { title: "Case Type", value: "Malware" },
            { title: "Assignee", value: "Unassigned" },
            { title: "Opened by", value: "Ana Analyst" },
          ],
          link: { title: "View Case", url: `http://argus.test/cases/${number}` },
        },
      },
    ]);
  });

  test("raising a Case's Severity to Critical is posted once; other changes aren't", async () => {
    const { t, open, change, headings } = await acme();
    const number = await open("high");
    await change(number, { severity: "medium", status: "triage" });
    await change(number, { severity: "critical" });
    await change(number, { status: "in_progress" });
    expect(headings()).toEqual([`C-${number} raised to Critical`]);
    expect(t.teams.posts[0]!.message.facts.at(-1)).toEqual({ title: "Raised by", value: "Olive Owner" });
  });

  test("a Restricted Case is posted as a link only", async () => {
    const { t, open, change } = await acme();
    const number = await open("high", undefined, "Exec mailbox compromise");
    await change(number, { restricted: true });
    await change(number, { severity: "critical" });
    expect(t.teams.posts.map((p) => p.message)).toEqual([
      { heading: "A Restricted Case was raised to Critical", facts: [], link: { title: "View Case", url: `http://argus.test/cases/${number}` } },
    ]);
    expect(JSON.stringify(adaptiveCard(t.teams.posts[0]!.message))).not.toContain("Exec mailbox");
  });

  test("a Case restricted before its post is sent is posted as a link only", async () => {
    const { t, open, change, sender } = await acme();
    t.teams.failNext();
    const number = await open("critical", undefined, "Exec mailbox compromise");
    expect(t.teams.posts).toEqual([]);
    await change(number, { restricted: true });
    t.clock.advance(MINUTE);
    await sender.tick();
    expect(t.teams.posts.map((p) => p.message)).toEqual([
      { heading: "A Restricted Critical Case was opened", facts: [], link: { title: "View Case", url: `http://argus.test/cases/${number}` } },
    ]);
  });

  test("a failed post is retried by the worker with backoff, and given up after five attempts", async () => {
    const { t, open, sender, headings } = await acme();
    t.teams.failNext(2);
    await open("critical");
    await sender.tick();
    expect(headings()).toEqual([]);
    t.clock.advance(30_000);
    await sender.tick(); // second failure
    t.clock.advance(30_000);
    await sender.tick(); // backoff is a minute now
    expect(headings()).toEqual([]);
    t.clock.advance(30_000);
    await sender.tick();
    await sender.tick();
    expect(headings()).toEqual(["New Critical Case opened"]);

    t.teams.failNext(MAX_TEAMS_ATTEMPTS + 1);
    await open("critical");
    for (let i = 0; i < MAX_TEAMS_ATTEMPTS + 1; i++) {
      t.clock.advance(60 * MINUTE);
      await sender.tick();
    }
    expect(headings()).toHaveLength(1);
    const given = await t.deps.db.query.teamsPosts.findMany({ where: (p, { eq }) => eq(p.pending, false) });
    expect(given.map((p) => [p.attempts, p.sentAt === null])).toContainEqual([MAX_TEAMS_ATTEMPTS, true]);
  });

  test("removing the channel drops posts not yet sent", async () => {
    const { t, owner, open, sender } = await acme();
    t.teams.failNext();
    await open("critical");
    await owner.api["teams-channel"].$delete();
    t.clock.advance(MINUTE);
    await sender.tick();
    expect(t.teams.posts).toEqual([]);
  });

  test("a post goes to the webhook set when it is sent", async () => {
    const { t, open, sender, setWebhook } = await acme();
    t.teams.failNext();
    await open("critical");
    await setWebhook(WORKFLOW);
    t.clock.advance(MINUTE);
    await sender.tick();
    expect(t.teams.posts.map((p) => p.webhookUrl)).toEqual([WORKFLOW]);
  });

  test("another Organization's Cases never reach this channel", async () => {
    const { t, open } = await acme();
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    await globex.api.cases.$post({ json: { title: "Globex outage", caseType: "other", severity: "critical" } });
    await open("critical");
    expect(t.teams.posts.map((p) => p.message.text)).toEqual(["C-1 · Suspicious PowerShell on FIN-LT-0231"]);
  });
});

/** Acme with a CrowdStrike Integration, and a way to open a Case from fresh Alerts of the given Severities. */
async function withAlerts() {
  const a = await acme();
  const { t, owner } = a;
  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: "falcon-client-0001", clientSecret: "s" } });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const stream = falcon.tenant("falcon-client-0001");
  const detect = async (compositeId: string, severity: "Critical" | "High" | "Low") => {
    stream.detection("EppDetectionSummaryEvent", compositeId, { Name: "Credential theft", SeverityName: severity, Hostname: "FIN-LT-0231" });
    await stream.drained();
  };
  const openFrom = async (severities: ("Critical" | "High" | "Low")[]) => {
    for (const [i, s] of severities.entries()) await detect(`cid:${s}:${i}:${crypto.randomUUID()}`, s);
    const queue = await (await a.ana.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in queue)) throw new Error("Could not list Alerts");
    const fresh = queue.alerts.filter((x) => x.status === "new");
    const res = await a.ana.api.alerts.cases.$post({
      json: { title: "Credential theft on FIN-LT-0231", caseType: "malware", alerts: fresh.map((x) => ({ id: x.id, version: x.version })) },
    });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case from Alerts: ${res.status}`);
    return body.case.number;
  };
  return { ...a, openFrom };
}

describe("Cases opened from Alerts", () => {
  test("is posted at any Severity, with how many Alerts it was opened from", async () => {
    const { t, openFrom, headings } = await withAlerts();
    const low = await openFrom(["Low"]);
    const critical = await openFrom(["High", "Critical", "Low"]);
    expect(headings()).toEqual(["New Case opened from 1 Alert", "New Critical Case opened from 3 Alerts"]);
    expect(t.teams.posts.map((p) => p.message.link.url)).toEqual([`http://argus.test/cases/${low}`, `http://argus.test/cases/${critical}`]);
    expect(t.teams.posts[0]!.message.facts[0]).toEqual({ title: "Severity", value: "Low" });
  });
});

test("posts are sent to Teams as an Adaptive Card", () => {
  const card = adaptiveCard({
    heading: "New Critical Case opened",
    text: "C-7 · Ransomware note on FS-01",
    facts: [{ title: "Severity", value: "Critical" }],
    link: { title: "View Case", url: "https://argus.example/cases/7" },
  });
  expect(card.type).toBe("message");
  const [attachment] = card.attachments;
  expect(attachment!.contentType).toBe("application/vnd.microsoft.card.adaptive");
  expect(attachment!.content.type).toBe("AdaptiveCard");
  expect(attachment!.content.body.map((b) => b.text ?? b.type)).toEqual(["Argus", "New Critical Case opened", "C-7 · Ransomware note on FS-01", "FactSet"]);
  expect(attachment!.content.actions).toEqual([{ type: "Action.OpenUrl", title: "View Case", url: "https://argus.example/cases/7" }]);
});
