import { describe, expect, test } from "bun:test";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const param = (number: number) => ({ number: String(number) });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Acme Security: the Owner, Ana (an Analyst, assigned to the Restricted Case) and Ben (an Analyst
 * who isn't), signed in; a CrowdStrike Integration delivering detections. The clock starts at
 * 2026-01-01T09:00Z.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  const join = async (email: string, name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const ana = await join("ana@acme.example", "Ana Analyst");
  const ben = await join("ben@acme.example", "Ben Analyst");
  type Session = typeof owner;
  const idOf = async (as: Session) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };
  const anaId = await idOf(ana);

  type Severity = "critical" | "high" | "medium" | "low" | "informational";
  const open = async (severity: Severity, { restricted = false, assigned = false } = {}) => {
    const body = await (await owner.api.cases.$post({ json: { title: `A ${severity} Case`, caseType: "malware", severity } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    const number = body.case.number;
    if (restricted || assigned) await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: anaId, restricted } });
    return number;
  };
  type Status = "triage" | "in_progress" | "awaiting_info" | "resolved";
  const move = async (number: number, status: Status) => {
    const res = await owner.api.cases[":number"].$patch({ param: param(number), json: { status } });
    if (res.status !== 200) throw new Error(`Could not move C-${number}: ${res.status}`);
  };
  const close = async (number: number) => {
    const res = await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } });
    if (res.status !== 200) throw new Error(`Could not close C-${number}: ${res.status}`);
  };

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const stream = falcon.tenant(CLIENT_ID);
  let detections = 0;
  /** Delivers a detection and returns its Alert's id and version. */
  const detect = async () => {
    const compositeId = `ldt:${++detections}`;
    stream.detection("EppDetectionSummaryEvent", compositeId, { Name: `Detection ${detections}`, SeverityName: "High" });
    await stream.drained();
    const body = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    const alert = body.alerts.find((a) => a.externalId === compositeId)!;
    return { id: alert.id, version: alert.version };
  };
  const dismiss = async (reason: "false_positive" | "benign" | "duplicate" | "other") => {
    const res = await owner.api.alerts.dismiss.$post({ json: { reason, alerts: [await detect()] } });
    if (res.status !== 200) throw new Error(`Could not dismiss: ${res.status}`);
  };
  const attach = async (number: number) => {
    const res = await owner.api.alerts.attach.$post({ json: { case: number, alerts: [await detect()] } });
    if (res.status !== 200) throw new Error(`Could not attach: ${res.status}`);
  };

  const dashboard = async (as: Session, days?: "7" | "30" | "90") => {
    const res = await as.api.metrics.dashboard.$get({ query: days ? { days } : {} });
    const body = await res.json();
    if (!("metrics" in body)) throw new Error(`Could not read the dashboard: ${res.status}`);
    return body.metrics;
  };

  return { t, owner, ana, ben, open, move, close, detect, dismiss, attach, dashboard };
}

describe("Metrics dashboard", () => {
  test("counts open Cases by Severity and Status, with how many are unassigned", async () => {
    const a = await acme();
    const critical = await a.open("critical", { assigned: true });
    await a.move(critical, "in_progress");
    await a.open("critical");
    await a.open("high");
    const resolved = await a.open("low");
    await a.move(resolved, "resolved");
    const closed = await a.open("medium");
    await a.close(closed);

    const { openCases } = await a.dashboard(a.ben);
    expect(openCases.total).toBe(4);
    expect(openCases.unassigned).toBe(3);
    expect(openCases.bySeverity.critical).toEqual({ new: 1, triage: 0, in_progress: 1, awaiting_info: 0, resolved: 0 });
    expect(openCases.bySeverity.high.new).toBe(1);
    expect(openCases.bySeverity.low.resolved).toBe(1);
    expect(openCases.bySeverity.medium).toEqual({ new: 0, triage: 0, in_progress: 0, awaiting_info: 0, resolved: 0 });
  });

  test("mean time to acknowledge is opened → first move out of New; mean time to close is opened → Closed", async () => {
    const a = await acme();
    const first = await a.open("high");
    a.t.clock.advance(30 * MINUTE);
    await a.move(first, "triage");
    a.t.clock.advance(30 * MINUTE);
    // Later moves don't acknowledge it again.
    await a.move(first, "in_progress");
    const second = await a.open("high");
    a.t.clock.advance(90 * MINUTE);
    // Closing straight from New acknowledges it too.
    await a.close(second);
    a.t.clock.advance(HOUR);
    await a.close(first);
    // Still New: not acknowledged, so it doesn't count.
    await a.open("low");

    const metrics = await a.dashboard(a.ben);
    // first: 30 min; second: 90 min.
    expect(metrics.meanTimeToAcknowledge).toEqual({ ms: 60 * MINUTE, cases: 2 });
    // first: 3.5 h; second: 1.5 h.
    expect(metrics.meanTimeToClose).toEqual({ ms: 150 * MINUTE, cases: 2 });
  });

  test("Restricted Cases count only for those who can see them", async () => {
    const a = await acme();
    const restricted = await a.open("critical", { restricted: true });
    a.t.clock.advance(10 * MINUTE);
    await a.move(restricted, "triage");
    a.t.clock.advance(10 * MINUTE);
    await a.close(restricted);
    await a.open("critical", { restricted: true });
    const other = await a.open("low");
    a.t.clock.advance(HOUR);
    await a.move(other, "triage");

    const ben = await a.dashboard(a.ben);
    expect(ben.openCases.total).toBe(1);
    expect(ben.openCases.bySeverity.critical.new).toBe(0);
    expect(ben.meanTimeToAcknowledge).toEqual({ ms: HOUR, cases: 1 });
    expect(ben.meanTimeToClose).toEqual({ ms: null, cases: 0 });

    for (const as of [a.ana, a.owner]) {
      const sees = await a.dashboard(as);
      expect(sees.openCases.total).toBe(2);
      expect(sees.openCases.bySeverity.critical.new).toBe(1);
      expect(sees.meanTimeToAcknowledge.cases).toBe(2);
      expect(sees.meanTimeToClose).toEqual({ ms: 20 * MINUTE, cases: 1 });
    }
  });

  test("Alert volume per day and the Dismissal rate by Dismissal Reason, over the period", async () => {
    const a = await acme();
    const number = await a.open("high");
    // 40 days ago: outside 30 days, inside 90.
    a.t.clock.advance(-40 * DAY);
    await a.dismiss("other");
    a.t.clock.advance(38 * DAY);
    await a.dismiss("false_positive");
    await a.dismiss("false_positive");
    a.t.clock.advance(DAY);
    await a.dismiss("benign");
    await a.attach(number);
    a.t.clock.advance(DAY);
    // Today: one still New, which isn't decided either way.
    await a.detect();

    const month = await a.dashboard(a.ben, "30");
    expect(month.days).toBe(30);
    expect(month.from).toBe("2025-12-03T00:00:00.000Z");
    expect(month.alerts.perDay).toHaveLength(30);
    expect(month.alerts.perDay.slice(-3)).toEqual([
      { date: "2025-12-30", count: 2 },
      { date: "2025-12-31", count: 2 },
      { date: "2026-01-01", count: 1 },
    ]);
    expect(month.alerts.received).toBe(5);
    expect(month.alerts.attached).toBe(1);
    expect(month.alerts.dismissed).toBe(3);
    expect(month.alerts.dismissalRate).toBe(0.75);
    expect(month.alerts.dismissalsByReason).toEqual({ false_positive: 2, benign: 1, duplicate: 0, other: 0 });

    const quarter = await a.dashboard(a.owner, "90");
    expect(quarter.alerts.received).toBe(6);
    expect(quarter.alerts.dismissalsByReason.other).toBe(1);
    expect(quarter.alerts.perDay).toHaveLength(90);

    const week = await a.dashboard(a.owner, "7");
    expect(week.alerts.received).toBe(5);
    expect(week.trend).toHaveLength(7);
    expect((await a.dashboard(a.owner, "30")).trend).toHaveLength(5);
  });

  test("the trend gives mean times per day or week; a Case acknowledged earlier is left out", async () => {
    const a = await acme();
    const early = await a.open("high");
    a.t.clock.advance(HOUR);
    await a.move(early, "triage");
    a.t.clock.advance(10 * DAY);
    const late = await a.open("high");
    a.t.clock.advance(2 * HOUR);
    await a.move(late, "triage");

    const week = await a.dashboard(a.owner, "7");
    expect(week.meanTimeToAcknowledge).toEqual({ ms: 2 * HOUR, cases: 1 });
    expect(week.trend.at(-1)).toEqual({ from: week.trend.at(-1)!.from, meanTimeToAcknowledgeMs: 2 * HOUR, meanTimeToCloseMs: null });
    expect(week.trend.slice(0, -1).every((p) => p.meanTimeToAcknowledgeMs === null)).toBe(true);

    const month = await a.dashboard(a.owner, "30");
    expect(month.meanTimeToAcknowledge).toEqual({ ms: 1.5 * HOUR, cases: 2 });
    expect(month.trend.filter((p) => p.meanTimeToAcknowledgeMs !== null).map((p) => p.meanTimeToAcknowledgeMs)).toEqual([HOUR, 2 * HOUR]);
  });

  test("Members only", async () => {
    const a = await acme();
    expect((await a.t.session().api.metrics.dashboard.$get({ query: {} })).status as number).toBe(401);
    expect((await a.ben.api.metrics.dashboard.$get({ query: { days: "14" } })).status).toBe(400);
  });
});
