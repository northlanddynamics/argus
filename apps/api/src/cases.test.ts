import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { CaseSummary } from "./cases/case-summary";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";

/** The Postgres error a query fails with (Drizzle wraps it as `cause`), or null if it succeeds. */
async function dbError(query: PromiseLike<unknown>) {
  try {
    await query;
    return null;
  } catch (e) {
    return String((e as { cause?: unknown }).cause ?? e);
  }
}

/** A Case Summary of one paragraph per line. */
const summary = (...lines: string[]): CaseSummary => ({
  type: "doc",
  content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
});

/** Acme Security: its Owner and an Analyst, signed in. */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const analyst = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Member = typeof owner;

  const userId = async (as: Member) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };

  type OpenInput = Parameters<Member["api"]["cases"]["$post"]>[0]["json"];
  const open = async (as: Member, json: Partial<OpenInput> = {}) => {
    const res = await as.api.cases.$post({
      json: { title: "Credential phishing — finance mailboxes", caseType: "phishing", severity: "high", ...json },
    });
    const body = await res.json();
    if (res.status !== 201 || !("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case;
  };

  const view = async (as: Member, number: number) => {
    const res = await as.api.cases[":number"].$get({ param: { number: String(number) } });
    return { status: res.status, body: await res.json() };
  };

  type ListQuery = Parameters<Member["api"]["cases"]["$get"]>[0]["query"];
  const list = async (as: Member, query: ListQuery = {}) => {
    const res = await as.api.cases.$get({ query });
    const body = await res.json();
    if (!("cases" in body)) throw new Error(`Could not list Cases: ${res.status}`);
    return body;
  };

  type Change = Parameters<Member["api"]["cases"][":number"]["$patch"]>[0]["json"];
  const change = (as: Member, number: number, json: Change) =>
    as.api.cases[":number"].$patch({ param: { number: String(number) }, json });

  const saveSummary = (as: Member, number: number, json: { summary: CaseSummary; version: number }) =>
    as.api.cases[":number"].summary.$put({ param: { number: String(number) }, json });

  type AuditQuery = Parameters<Member["api"]["cases"][":number"]["audit-log"]["$get"]>[0]["query"];
  const auditLog = async (as: Member, number: number, query: AuditQuery = {}) => {
    const res = await as.api.cases[":number"]["audit-log"].$get({ param: { number: String(number) }, query });
    const body = await res.json();
    if (!("entries" in body)) throw new Error(`Audit log: ${res.status}`);
    return body.entries;
  };

  type CloseBody = Parameters<Member["api"]["cases"][":number"]["close"]["$post"]>[0]["json"];
  const close = (as: Member, number: number, json: CloseBody) =>
    as.api.cases[":number"].close.$post({ param: { number: String(number) }, json });

  const reopen = (as: Member, number: number) => as.api.cases[":number"].reopen.$post({ param: { number: String(number) } });

  /** An Admin of Acme, signed in. */
  const admin = async () => {
    await owner.api.organization.invitations.$post({ json: { email: "adam@acme.example", role: "admin" } });
    return t.acceptInvite("adam@acme.example", PASSWORD, "Adam Admin");
  };

  return { t, owner, analyst, userId, open, view, list, change, saveSummary, auditLog, close, reopen, admin };
}

describe("Opening a Case", () => {
  test("a Member opens a Case with a title, Case Type, Severity and Case Summary; it starts in New, unassigned", async () => {
    const { analyst, open, view, userId } = await acme();
    const opened = await open(analyst, {
      title: "Suspicious PowerShell on FIN-LT-0231",
      caseType: "malware",
      severity: "critical",
      summary: summary("Falcon flagged encoded PowerShell."),
    });
    expect(opened).toMatchObject({ number: 1, status: "new", assignee: null });

    const { status, body } = await view(analyst, opened.number);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      case: {
        number: 1,
        title: "Suspicious PowerShell on FIN-LT-0231",
        status: "new",
        severity: "critical",
        caseType: "malware",
        assignee: null,
        openedBy: { id: await userId(analyst), name: "Ana Analyst" },
        summary: { content: summary("Falcon flagged encoded PowerShell."), version: 1 },
      },
    });
  });

  test("Cases are numbered in order within the Organization", async () => {
    const { owner, analyst, open } = await acme();
    expect((await open(owner)).number).toBe(1);
    expect((await open(analyst)).number).toBe(2);
    expect((await open(owner)).number).toBe(3);
  });

  test("Case Type and Severity must come from their fixed lists", async () => {
    const { analyst } = await acme();
    const post = (json: Record<string, unknown>) =>
      analyst.api.cases.$post({ json: { title: "x", caseType: "phishing", severity: "high", ...json } as never });
    expect((await post({ caseType: "ransomware" })).status).toBe(400);
    expect((await post({ severity: "sev1" })).status).toBe(400);
    expect((await post({ title: "  " })).status).toBe(400);
  });

  test("the Case Summary accepts only the supported rich text", async () => {
    const { analyst, open, view } = await acme();
    const rich: CaseSummary = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "What we know" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Host ", marks: [{ type: "bold" }] },
            { type: "text", text: "contained", marks: [{ type: "italic" }, { type: "link", attrs: { href: "https://falcon.example/x" } }] },
          ],
        },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "memory image" }] }] }],
        },
      ],
    };
    const opened = await open(analyst, { summary: rich });
    const { body } = await view(analyst, opened.number);
    expect(body).toMatchObject({ case: { summary: { content: rich } } });

    const script = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
    };
    const html = { type: "doc", content: [{ type: "html", content: "<script>alert(1)</script>" }] };
    for (const bad of [script, html]) {
      const res = await analyst.api.cases.$post({ json: { title: "x", caseType: "other", severity: "low", summary: bad as never } });
      expect(res.status).toBe(400);
    }
  });

  test("opening is recorded in the Case's Audit Log", async () => {
    const { t, analyst, open, auditLog, userId } = await acme();
    const opened = await open(analyst, { severity: "high" });
    expect(await auditLog(analyst, opened.number)).toEqual([
      {
        id: expect.any(String),
        occurredAt: t.clock.now().toISOString(),
        actor: { type: "member", id: await userId(analyst), name: "Ana Analyst" },
        action: "case.opened",
        before: null,
        after: "Credential phishing — finance mailboxes",
      },
    ]);
  });
});

describe("Changing a Case", () => {
  test("Status moves through the fixed list, each change recorded with before and after", async () => {
    const { t, analyst, open, change, view, auditLog } = await acme();
    const { number } = await open(analyst);
    for (const status of ["triage", "in_progress", "awaiting_info", "in_progress", "resolved"] as const) {
      t.clock.advance(60_000);
      expect((await change(analyst, number, { status })).status).toBe(200);
    }
    expect((await view(analyst, number)).body).toMatchObject({ case: { status: "resolved" } });
    const entries = await auditLog(analyst, number);
    expect(entries.filter((e) => e.action === "case.status_changed").map((e) => [e.before, e.after])).toEqual([
      ["in_progress", "resolved"],
      ["awaiting_info", "in_progress"],
      ["in_progress", "awaiting_info"],
      ["triage", "in_progress"],
      ["new", "triage"],
    ]);
  });

  test("an unknown Status is refused, and closing needs a Resolution, which this route does not take", async () => {
    const { analyst, open, change } = await acme();
    const { number } = await open(analyst);
    expect((await change(analyst, number, { status: "done" as never })).status).toBe(400);
    expect((await change(analyst, number, { status: "closed" as never })).status).toBe(400);
  });

  test("Severity and Case Type change, each with its own Audit Log entry", async () => {
    const { analyst, open, change, view, auditLog } = await acme();
    const { number } = await open(analyst, { severity: "high", caseType: "phishing" });
    expect((await change(analyst, number, { severity: "critical", caseType: "account_compromise" })).status).toBe(200);
    expect((await view(analyst, number)).body).toMatchObject({ case: { severity: "critical", caseType: "account_compromise" } });
    const entries = await auditLog(analyst, number);
    expect(entries.map((e) => [e.action, e.before, e.after])).toContainEqual(["case.severity_changed", "high", "critical"]);
    expect(entries.map((e) => [e.action, e.before, e.after])).toContainEqual(["case.case_type_changed", "phishing", "account_compromise"]);
  });

  test("setting a field to its current value changes nothing and records nothing", async () => {
    const { analyst, open, change, auditLog } = await acme();
    const { number } = await open(analyst, { severity: "high" });
    expect((await change(analyst, number, { severity: "high", status: "new" })).status).toBe(200);
    expect((await auditLog(analyst, number)).map((e) => e.action)).toEqual(["case.opened"]);
  });

  test("the Assignee is set to a Member, changed and cleared, recorded by name", async () => {
    const { owner, analyst, open, change, view, auditLog, userId } = await acme();
    const { number } = await open(analyst);
    const ana = await userId(analyst);
    const olive = await userId(owner);

    expect((await change(analyst, number, { assigneeId: ana })).status).toBe(200);
    expect((await view(owner, number)).body).toMatchObject({ case: { assignee: { id: ana, name: "Ana Analyst" } } });
    expect((await change(owner, number, { assigneeId: olive })).status).toBe(200);
    expect((await change(owner, number, { assigneeId: null })).status).toBe(200);
    expect((await view(owner, number)).body).toMatchObject({ case: { assignee: null } });

    const entries = (await auditLog(owner, number)).filter((e) => e.action === "case.assignee_changed");
    expect(entries.map((e) => [e.actor.name, e.before, e.after])).toEqual([
      ["Olive Owner", "Olive Owner", null],
      ["Olive Owner", "Ana Analyst", "Olive Owner"],
      ["Ana Analyst", null, "Ana Analyst"],
    ]);
  });

  test("the Assignee must be a Member of the Organization", async () => {
    const { t, analyst, open, change } = await acme();
    const { number } = await open(analyst);
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    const globexMe = await (await globex.api.me.$get()).json();
    if (!("user" in globexMe)) throw new Error("Not signed in");
    expect((await change(analyst, number, { assigneeId: globexMe.user.id })).status).toBe(400);
    expect((await change(analyst, number, { assigneeId: "nobody" })).status).toBe(400);
  });

  test("a Case that does not exist is not found", async () => {
    const { analyst, change, view } = await acme();
    expect((await view(analyst, 99)).status).toBe(404);
    expect((await change(analyst, 99, { severity: "low" })).status).toBe(404);
  });
});

describe("Listing Cases", () => {
  test("All open lists every Case that isn't Closed, most recently changed first, with filters", async () => {
    const { t, analyst, open, change, list } = await acme();
    const a = await open(analyst, { title: "A", severity: "high", caseType: "phishing" });
    t.clock.advance(1000);
    const b = await open(analyst, { title: "B", severity: "low", caseType: "malware" });
    t.clock.advance(1000);
    await change(analyst, a.number, { status: "triage" });

    expect((await list(analyst)).cases.map((c) => c.title)).toEqual(["A", "B"]);
    expect((await list(analyst, { severity: "low" })).cases.map((c) => c.title)).toEqual(["B"]);
    expect((await list(analyst, { caseType: "phishing" })).cases.map((c) => c.title)).toEqual(["A"]);
    expect((await list(analyst, { status: "new" })).cases.map((c) => c.title)).toEqual(["B"]);
    expect((await list(analyst)).cases[0]).toMatchObject({
      number: a.number,
      title: "A",
      status: "triage",
      severity: "high",
      caseType: "phishing",
      assignee: null,
      updatedAt: t.clock.now().toISOString(),
    });
    void b;
  });

  test("my Cases and unassigned views, with counts for each", async () => {
    const { owner, analyst, open, change, list, userId } = await acme();
    const ana = await userId(analyst);
    const mine = await open(owner, { title: "Mine" });
    await change(owner, mine.number, { assigneeId: ana });
    await open(owner, { title: "Nobody's" });
    const olives = await open(owner, { title: "Olive's" });
    await change(owner, olives.number, { assigneeId: await userId(owner) });

    expect((await list(analyst, { view: "mine" })).cases.map((c) => c.title)).toEqual(["Mine"]);
    expect((await list(analyst, { view: "unassigned" })).cases.map((c) => c.title)).toEqual(["Nobody's"]);
    expect((await list(owner, { view: "mine" })).cases.map((c) => c.title)).toEqual(["Olive's"]);
    expect((await list(analyst)).counts).toEqual({ mine: 1, unassigned: 1, open: 3, closed: 0 });
  });
});

describe("Case Summary", () => {
  test("saving with the current version replaces the Case Summary and moves the version on", async () => {
    const { t, owner, analyst, open, saveSummary, view, auditLog } = await acme();
    const { number } = await open(analyst, { summary: summary("First draft") });
    t.clock.advance(60_000);
    const res = await saveSummary(owner, number, { summary: summary("What we know: host contained."), version: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: { version: 2 } });
    expect((await view(analyst, number)).body).toMatchObject({
      case: {
        summary: {
          content: summary("What we know: host contained."),
          version: 2,
          updatedBy: { name: "Olive Owner" },
          updatedAt: t.clock.now().toISOString(),
        },
      },
    });
    const [entry] = await auditLog(analyst, number);
    expect(entry).toMatchObject({ action: "case.summary_edited", actor: { name: "Olive Owner" } });
    expect(JSON.parse(entry!.before!)).toEqual(summary("First draft"));
    expect(JSON.parse(entry!.after!)).toEqual(summary("What we know: host contained."));
  });

  test("a save based on a stale version is refused with a conflict carrying the current state", async () => {
    const { owner, analyst, open, saveSummary, view, auditLog } = await acme();
    const { number } = await open(analyst, { summary: summary("v1") });
    // Both opened version 1; Olive saves first.
    expect((await saveSummary(owner, number, { summary: summary("Olive's v2"), version: 1 })).status).toBe(200);
    const stale = await saveSummary(analyst, number, { summary: summary("Ana's edit"), version: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: expect.stringContaining("changed"),
      current: { content: summary("Olive's v2"), version: 2, updatedBy: { name: "Olive Owner" } },
    });
    expect((await view(analyst, number)).body).toMatchObject({ case: { summary: { content: summary("Olive's v2"), version: 2 } } });
    expect((await auditLog(analyst, number)).filter((e) => e.action === "case.summary_edited")).toHaveLength(1);

    // Ana reloads the current version and saves on top of it.
    expect((await saveSummary(analyst, number, { summary: summary("Ana's edit"), version: 2 })).status).toBe(200);
  });

  test("a Case opened without a Case Summary starts with an empty one", async () => {
    const { analyst, open, view } = await acme();
    const { number } = await open(analyst);
    expect((await view(analyst, number)).body).toMatchObject({
      case: { summary: { content: { type: "doc", content: [] }, version: 1 } },
    });
  });
});

describe("Closing a Case", () => {
  test("closing records a Resolution from the fixed list, who closed it and when", async () => {
    const { t, analyst, open, change, close, view, auditLog, userId } = await acme();
    const { number } = await open(analyst);
    await change(analyst, number, { status: "in_progress" });
    t.clock.advance(60_000);
    const res = await close(analyst, number, { resolution: "true_positive" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ case: { status: "closed", resolution: "true_positive" } });
    expect((await view(analyst, number)).body).toMatchObject({
      case: {
        status: "closed",
        resolution: "true_positive",
        closed: { by: { id: await userId(analyst), name: "Ana Analyst" }, at: t.clock.now().toISOString() },
      },
    });
    const [entry] = await auditLog(analyst, number);
    expect(entry).toMatchObject({ action: "case.closed", actor: { name: "Ana Analyst" }, before: "in_progress", after: "true_positive" });
  });

  test("closing without a Resolution from the fixed list is refused", async () => {
    const { analyst, open, close, view, auditLog } = await acme();
    const { number } = await open(analyst);
    expect((await close(analyst, number, {} as never)).status).toBe(400);
    expect((await close(analyst, number, { resolution: "resolved" as never })).status).toBe(400);
    expect((await close(analyst, number, { resolution: "" as never })).status).toBe(400);
    expect((await view(analyst, number)).body).toMatchObject({ case: { status: "new", resolution: null, closed: null } });
    expect((await auditLog(analyst, number)).map((e) => e.action)).toEqual(["case.opened"]);
  });

  test("every Resolution closes a Case", async () => {
    const { analyst, open, close } = await acme();
    for (const resolution of ["true_positive", "benign", "false_positive", "duplicate"] as const) {
      const { number } = await open(analyst);
      expect((await close(analyst, number, { resolution })).status).toBe(200);
    }
  });

  test("a Closed Case is read-only: changes, Case Summary saves and closing again are refused", async () => {
    const { t, owner, analyst, open, close, change, saveSummary, view, auditLog, userId } = await acme();
    const { number } = await open(analyst, { severity: "high" });
    await close(analyst, number, { resolution: "benign" });
    const before = (await view(analyst, number)).body;

    for (const as of [analyst, owner]) {
      const refused = [
        await change(as, number, { severity: "low" }),
        await change(as, number, { status: "in_progress" }),
        await change(as, number, { caseType: "malware" }),
        await change(as, number, { assigneeId: await userId(as) }),
        await saveSummary(as, number, { summary: summary("Late note"), version: 1 }),
        await close(as, number, { resolution: "false_positive" }),
      ];
      for (const res of refused) {
        expect(res.status as number).toBe(409);
        expect(await res.json()).toMatchObject({ error: expect.stringContaining("read-only") });
      }
    }
    expect((await view(analyst, number)).body).toEqual(before);
    expect((await auditLog(analyst, number)).map((e) => e.action)).toEqual(["case.closed", "case.opened"]);

    // Going around the application doesn't work either.
    expect(await dbError(t.deps.db.execute(sql`UPDATE cases SET severity = 'low'`))).toMatch(/Closed and read-only/);
  });

  test("Resolved means work done, awaiting review: the Case stays editable", async () => {
    const { analyst, open, change, saveSummary, view } = await acme();
    const { number } = await open(analyst, { severity: "high" });
    expect((await change(analyst, number, { status: "resolved" })).status).toBe(200);
    expect((await change(analyst, number, { severity: "medium" })).status).toBe(200);
    expect((await saveSummary(analyst, number, { summary: summary("Reviewed"), version: 1 })).status).toBe(200);
    expect((await change(analyst, number, { status: "in_progress" })).status).toBe(200);
    expect((await view(analyst, number)).body).toMatchObject({ case: { status: "in_progress", severity: "medium", resolution: null } });
  });

  test("the Status and Resolution must agree at the database", async () => {
    const { t, analyst, open } = await acme();
    await open(analyst);
    const { db } = t.deps;
    expect(await dbError(db.execute(sql`UPDATE cases SET status = 'closed'`))).toMatch(/cases_closed_has_resolution/);
    expect(await dbError(db.execute(sql`UPDATE cases SET resolution = 'benign'`))).toMatch(/cases_closed_has_resolution/);
  });

  test("Closed Cases leave the open views and show in Closed, with their Resolution", async () => {
    const { analyst, open, close, list } = await acme();
    await open(analyst, { title: "Still open" });
    const done = await open(analyst, { title: "Done" });
    await close(analyst, done.number, { resolution: "false_positive" });
    expect((await list(analyst)).cases.map((c) => c.title)).toEqual(["Still open"]);
    expect((await list(analyst, { view: "closed" })).cases).toEqual([
      expect.objectContaining({ title: "Done", status: "closed", resolution: "false_positive" }),
    ]);
    expect((await list(analyst)).counts).toMatchObject({ open: 1, closed: 1 });
  });
});

describe("Reopening a Case", () => {
  test("an Admin reopens a Closed Case: it goes back to In Progress without a Resolution, recorded in the Audit Log", async () => {
    const { t, analyst, open, close, reopen, view, change, auditLog, admin } = await acme();
    const adam = await admin();
    const { number } = await open(analyst);
    await close(analyst, number, { resolution: "duplicate" });
    t.clock.advance(60_000);

    const res = await reopen(adam, number);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ case: { status: "in_progress", resolution: null, closed: null } });
    const [entry] = await auditLog(analyst, number);
    expect(entry).toMatchObject({
      action: "case.reopened",
      actor: { name: "Adam Admin" },
      occurredAt: t.clock.now().toISOString(),
      before: "duplicate",
      after: "in_progress",
    });

    // Editable again, and can be closed again.
    expect((await change(analyst, number, { severity: "low" })).status).toBe(200);
    expect((await close(analyst, number, { resolution: "true_positive" })).status).toBe(200);
    expect((await view(analyst, number)).body).toMatchObject({ case: { status: "closed", resolution: "true_positive" } });
  });

  test("the Owner can reopen", async () => {
    const { owner, analyst, open, close, reopen } = await acme();
    const { number } = await open(analyst);
    await close(analyst, number, { resolution: "benign" });
    expect((await reopen(owner, number)).status).toBe(200);
  });

  test("an Analyst cannot reopen, and nothing is recorded", async () => {
    const { analyst, open, close, reopen, view, auditLog } = await acme();
    const { number } = await open(analyst);
    await close(analyst, number, { resolution: "benign" });
    expect((await reopen(analyst, number)).status as number).toBe(403);
    expect((await view(analyst, number)).body).toMatchObject({ case: { status: "closed", resolution: "benign" } });
    expect((await auditLog(analyst, number)).map((e) => e.action)).toEqual(["case.closed", "case.opened"]);
  });

  test("only a Closed Case can be reopened", async () => {
    const { owner, analyst, open, change, reopen } = await acme();
    const { number } = await open(analyst);
    await change(analyst, number, { status: "resolved" });
    expect((await reopen(owner, number)).status as number).toBe(409);
    expect((await reopen(owner, 99)).status as number).toBe(404);
  });

  test("another Organization can neither close nor reopen a Case", async () => {
    const { t, analyst, open, close, reopen, view } = await acme();
    const a = await open(analyst);
    const b = await open(analyst);
    await close(analyst, b.number, { resolution: "benign" });
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    expect((await close(globex, a.number, { resolution: "benign" })).status as number).toBe(404);
    expect((await reopen(globex, b.number)).status as number).toBe(404);
    expect((await view(analyst, a.number)).body).toMatchObject({ case: { status: "new" } });
    expect((await view(analyst, b.number)).body).toMatchObject({ case: { status: "closed" } });
  });
});

describe("Case Audit Log", () => {
  test("newest first, filterable by actor, action and time", async () => {
    const { t, owner, analyst, open, change, auditLog, userId } = await acme();
    const { number } = await open(analyst);
    t.clock.advance(60_000);
    const later = t.clock.now().toISOString();
    await change(owner, number, { status: "triage" });
    t.clock.advance(60_000);
    await change(analyst, number, { severity: "critical" });

    expect((await auditLog(owner, number)).map((e) => e.action)).toEqual([
      "case.severity_changed",
      "case.status_changed",
      "case.opened",
    ]);
    expect((await auditLog(owner, number, { actor: await userId(owner) })).map((e) => e.action)).toEqual(["case.status_changed"]);
    expect((await auditLog(owner, number, { action: "case.opened" })).map((e) => e.action)).toEqual(["case.opened"]);
    expect((await auditLog(owner, number, { from: later })).map((e) => e.action)).toEqual([
      "case.severity_changed",
      "case.status_changed",
    ]);
  });

  test("entries belong to their own Case", async () => {
    const { analyst, open, change, auditLog } = await acme();
    const a = await open(analyst);
    const b = await open(analyst);
    await change(analyst, b.number, { severity: "low" });
    expect((await auditLog(analyst, a.number)).map((e) => e.action)).toEqual(["case.opened"]);
  });

  test("is append-only: UPDATE, DELETE and TRUNCATE fail at the database", async () => {
    const { t, analyst, open } = await acme();
    await open(analyst);
    const { db } = t.deps;
    expect(await dbError(db.execute(sql`UPDATE case_audit_log SET after = 'tampered'`))).toMatch(/append-only/);
    expect(await dbError(db.execute(sql`DELETE FROM case_audit_log`))).toMatch(/append-only/);
    expect(await dbError(db.execute(sql`TRUNCATE case_audit_log`))).toMatch(/append-only/);
  });
});

describe("Cases cannot be deleted", () => {
  test("there is no delete route, and the database refuses DELETE and TRUNCATE", async () => {
    const { t, owner, open, view } = await acme();
    const { number } = await open(owner);
    // The RPC client has no `$delete` here because the route doesn't exist; it still sends one.
    const caseRoute = owner.api.cases[":number"] as unknown as { $delete: (args: { param: { number: string } }) => Promise<Response> };
    expect((await caseRoute.$delete({ param: { number: String(number) } })).status).toBe(404);
    const { db } = t.deps;
    expect(await dbError(db.execute(sql`DELETE FROM cases`))).toMatch(/cannot be deleted/);
    expect(await dbError(db.execute(sql`TRUNCATE cases CASCADE`))).toMatch(/cannot be deleted|append-only/);
    expect((await view(owner, number)).status).toBe(200);
  });
});

describe("Organization isolation", () => {
  test("a Member of another Organization cannot list, view, change or read the Audit Log of a Case", async () => {
    const { t, analyst, open, list, view, change, saveSummary, auditLog } = await acme();
    const acmeCase = await open(analyst, { title: "Acme's Case" });

    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    expect((await list(globex)).cases).toEqual([]);
    expect((await list(globex)).counts).toEqual({ mine: 0, unassigned: 0, open: 0, closed: 0 });
    expect((await view(globex, acmeCase.number)).status).toBe(404);
    expect((await change(globex, acmeCase.number, { severity: "low" })).status).toBe(404);
    expect((await saveSummary(globex, acmeCase.number, { summary: summary("x"), version: 1 })).status).toBe(404);
    const audit = await globex.api.cases[":number"]["audit-log"].$get({ param: { number: String(acmeCase.number) }, query: {} });
    expect(audit.status).toBe(404);

    // Globex's own Case 1 is a different Case; Acme's stays untouched.
    const globexCase = await open(globex, { title: "Globex's Case" });
    expect(globexCase.number).toBe(1);
    expect((await view(globex, 1)).body).toMatchObject({ case: { title: "Globex's Case" } });
    expect((await view(analyst, 1)).body).toMatchObject({ case: { title: "Acme's Case", severity: "high" } });
    expect((await auditLog(analyst, 1)).map((e) => e.action)).toEqual(["case.opened"]);
  });

  test("signed-out people and Operators get no Cases", async () => {
    const { t, analyst, open } = await acme();
    await open(analyst);
    const anonymous = t.session();
    // Refused by the membership check in front of every route, which the RPC types don't see.
    expect((await anonymous.api.cases.$get({ query: {} })).status as number).toBe(401);
    const operator = await t.createOperator();
    expect((await operator.api.cases.$get({ query: {} })).status as number).toBe(403);
    expect((await operator.api.cases[":number"].$get({ param: { number: "1" } })).status as number).toBe(403);
  });
});
