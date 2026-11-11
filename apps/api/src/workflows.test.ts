import { describe, expect, test } from "bun:test";
import { fakeFalcon, fakeWorkflow } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";
import { createWorkflowRunner, WORKFLOW_DISCOVERY_INTERVAL_MS, WORKFLOWS_UNAVAILABLE, workflowCheckDelayMs } from "./workflows/runner";
import { WORKFLOW_RUN_WATCH_MS } from "./workflows/vocabulary";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const ISOLATE = "def-isolate-0001";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: its Owner and Ana (an Analyst), a CrowdStrike Integration whose Falcon holds an
 * on-demand Workflow ("Isolate and notify"), a scheduled one and one that is off, a High Case opened
 * by Ana with outside counsel on it as a Guest, and a Workflow runner on the fake Falcon.
 */
async function acme({ workflowsOn = true } = {}) {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = typeof ana;

  const res = await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } });
  const added = await res.json();
  if (!("integration" in added)) throw new Error(`Could not add an Integration: ${res.status}`);
  const integrationId = added.integration.id;
  if (workflowsOn) await owner.api.integrations[":id"].workflows.$put({ param: { id: integrationId }, json: { enabled: true } });

  const opened = await (await ana.api.cases.$post({ json: { title: "Phishing at Acme", caseType: "phishing", severity: "high" } })).json();
  if (!("case" in opened)) throw new Error("Could not open a Case");
  const number = opened.case.number;
  await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel" } });
  const guest = await t.guestSignIn(COUNSEL);

  const falcon = fakeFalcon();
  const tenant = falcon.tenant(CLIENT_ID);
  tenant.workflows.set(ISOLATE, fakeWorkflow(ISOLATE));
  tenant.workflows.set("def-nightly", fakeWorkflow("def-nightly", { name: "Nightly sweep", onDemand: false, inputs: [] }));
  tenant.workflows.set("def-off", fakeWorkflow("def-off", { name: "Old enrichment", enabled: false, inputs: [] }));
  const runner = createWorkflowRunner(t.deps, { connect: falcon.connect });

  const list = async (as: Session = ana) => {
    const body = await (await as.api.workflows.$get()).json();
    if (!("workflows" in body)) throw new Error("Could not list Workflows");
    return body;
  };
  /** The id Argus gave the Workflow Falcon knows by `definitionId`. */
  const workflowId = async (definitionId = ISOLATE) => (await list()).workflows.find((w) => w.definitionId === definitionId)!.id;
  const run = async (as: Session, id: string, json: Parameters<Session["api"]["workflows"][":id"]["run"]["$post"]>[0]["json"]) => {
    const r = await as.api.workflows[":id"].run.$post({ param: { id }, json });
    return { status: r.status, body: (await r.json()) as { run?: { id: string }; error?: string } };
  };
  const view = async (id: string, as: Session = ana) => {
    const body = await (await as.api.workflows.runs[":id"].$get({ param: { id } })).json();
    if (!("run" in body)) throw new Error("Could not read the run");
    return body.run;
  };
  const log = async (as: Session = ana, query: Record<string, string> = {}) => {
    const body = await (await as.api["action-log"].$get({ query })).json();
    if (!("entries" in body)) throw new Error("Could not read the Action Log");
    return body.entries;
  };
  const caseAudit = async (on = number) => {
    const body = await (await owner.api.cases[":number"]["audit-log"].$get({ param: param(on), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Case Audit Log");
    return body.entries;
  };
  return { t, owner, ana, guest, integrationId, number, tenant, runner, list, workflowId, run, view, log, caseAudit };
}

describe("Discovering Workflows", () => {
  test("lists every workflow Falcon holds, saying which can run from Argus and why the rest can't", async () => {
    const a = await acme();
    expect((await a.list()).workflows).toEqual([]);
    await a.runner.tick();

    const { sources, workflows } = await a.list();
    expect(sources).toEqual([
      { integration: { id: a.integrationId, name: "CrowdStrike — Prod" }, enabled: true, paused: false, refreshing: false, checkedAt: a.t.clock.now().toISOString(), error: null },
    ]);
    expect(workflows.map((w) => [w.name, w.status, w.statusText])).toEqual([
      ["Isolate and notify", "ready", "Ready"],
      ["Nightly sweep", "not_on_demand", "Runs on its own trigger"],
      ["Old enrichment", "disabled", "Off in Falcon"],
    ]);
    expect(workflows[0]).toMatchObject({ definitionId: ISOLATE, integration: { id: a.integrationId }, inputs: fakeWorkflow(ISOLATE).inputs });
  });

  test("discovers again every 15 minutes, or when a Member refreshes, and keeps what Falcon stops listing, marked removed", async () => {
    const a = await acme();
    await a.runner.tick();
    await a.runner.tick();
    expect(a.tenant.workflowListings).toBe(1);

    a.tenant.workflows.delete("def-off");
    a.tenant.workflows.set(ISOLATE, fakeWorkflow(ISOLATE, { name: "Isolate, notify and ticket" }));
    expect((await a.ana.api.workflows.refresh.$post({ json: {} })).status).toBe(200);
    expect((await a.list()).sources[0]!.refreshing).toBe(true);
    await a.runner.tick();
    expect(a.tenant.workflowListings).toBe(2);
    expect((await a.list()).workflows.map((w) => [w.name, w.status])).toEqual([
      ["Isolate, notify and ticket", "ready"],
      ["Nightly sweep", "not_on_demand"],
      ["Old enrichment", "removed"],
    ]);

    a.t.clock.advance(WORKFLOW_DISCOVERY_INTERVAL_MS + 1);
    a.tenant.workflows.set("def-off", fakeWorkflow("def-off", { name: "Old enrichment", enabled: false, inputs: [] }));
    await a.runner.tick();
    expect(a.tenant.workflowListings).toBe(3);
    expect((await a.list()).workflows.find((w) => w.definitionId === "def-off")!.status).toBe("disabled");
  });

  test("without Workflow: Read, the Integration says so and what was discovered before stays", async () => {
    const a = await acme();
    await a.runner.tick();
    a.tenant.refuseWorkflowReads = "403 access denied";
    await a.ana.api.workflows.refresh.$post({ json: {} });
    await a.runner.tick();
    const { sources, workflows } = await a.list();
    expect(sources[0]!.error).toBe(WORKFLOWS_UNAVAILABLE);
    expect(workflows).toHaveLength(3);
    const integrations = await (await a.owner.api.integrations.$get()).json();
    if (!("integrations" in integrations)) throw new Error("No Integrations");
    expect(integrations.integrations[0]!.workflowDiscovery).toMatchObject({ count: 3, error: WORKFLOWS_UNAVAILABLE });

    a.tenant.refuseWorkflowReads = null;
    await a.ana.api.workflows.refresh.$post({ json: {} });
    await a.runner.tick();
    expect((await a.list()).sources[0]!.error).toBeNull();
  });

  test("a paused Integration isn't asked", async () => {
    const a = await acme();
    await a.owner.api.integrations[":id"].pause.$post({ param: { id: a.integrationId } });
    await a.runner.tick();
    expect(a.tenant.workflowListings).toBe(0);
  });

  test("Guests see no Workflows", async () => {
    const a = await acme();
    expect((await a.guest.api.workflows.$get()).status as number).toBe(403);
  });
});

describe("Running a Workflow and watching its outcome", () => {
  test("is queued, sent to Falcon with its inputs, and watched until Falcon reports it completed", async () => {
    const a = await acme();
    await a.runner.tick();
    const id = await a.workflowId();

    const { status, body } = await a.run(a.ana, id, { inputs: { hostname: "FIN-LT-0231", notify: "true" }, caseNumber: a.number });
    expect(status).toBe(201);
    const runId = body.run!.id;
    expect(await a.view(runId)).toMatchObject({ state: "pending", case: { number: a.number }, by: { name: "Ana Analyst" }, inputs: { hostname: "FIN-LT-0231", notify: true } });

    await a.runner.tick();
    expect(a.tenant.executions).toHaveLength(1);
    expect(a.tenant.executions[0]).toMatchObject({ definitionId: ISOLATE, inputs: { hostname: "FIN-LT-0231", notify: true } });
    const executionId = a.tenant.executions[0]!.id;
    expect(await a.view(runId)).toMatchObject({ state: "running", executionId, startedAt: a.t.clock.now().toISOString() });

    // Not read again until its next check is due.
    await a.runner.tick();
    expect(a.tenant.executionReads).toHaveLength(0);
    a.t.clock.advance(workflowCheckDelayMs(0));
    await a.runner.tick();
    expect(a.tenant.executionReads).toEqual([[executionId]]);
    expect(await a.view(runId)).toMatchObject({ state: "running", falconStatus: "In progress", activities: [{ name: "Contain host", status: "In progress" }] });

    a.tenant.finish("completed", { activities: [{ name: "Contain host", status: "Completed" }, { name: "Post to SOC", status: "Completed" }], output: { ticket: "INC-4411" } });
    a.t.clock.advance(workflowCheckDelayMs(1));
    await a.runner.tick();
    const done = await a.view(runId);
    expect(done).toMatchObject({ state: "completed", falconStatus: "Completed", output: { ticket: "INC-4411" }, error: null, retryable: false });
    expect(done.activities).toHaveLength(2);
    expect(done.finishedAt).not.toBeNull();

    // Finished: never read again.
    a.t.clock.advance(60 * 60_000);
    await a.runner.tick();
    expect(a.tenant.executionReads).toHaveLength(2);

    const [entry] = await a.log();
    expect(entry).toMatchObject({ action: "workflow_run", group: "workflow", label: "Workflow", value: { type: "workflow", value: "Isolate and notify" }, state: "completed", case: { number: a.number }, workflowRun: { id: runId, retryable: false } });
    expect((await a.caseAudit()).filter((e) => e.action.startsWith("workflow_run.")).map((e) => [e.action, e.actor.name, e.after])).toEqual([
      ["workflow_run.finished", "Argus", "Completed"],
      ["workflow_run.requested", "Ana Analyst", "hostname=FIN-LT-0231 · notify=true"],
    ]);
  });

  test("a run Falcon reports failed is Failed with why, and the Member who ran it for a Case is notified", async () => {
    const a = await acme();
    await a.runner.tick();
    const { body } = await a.run(a.ana, await a.workflowId(), { inputs: { hostname: "FIN-LT-0231" }, caseNumber: a.number });
    await a.runner.tick();
    a.tenant.finish("failed", { error: "Host not found" });
    a.t.clock.advance(workflowCheckDelayMs(0));
    await a.runner.tick();
    expect(await a.view(body.run!.id)).toMatchObject({ state: "failed", error: "Host not found", retryable: false });
    expect(await (await a.ana.api.notifications.$get()).json()).toMatchObject({ unread: 1, notifications: [{ kind: "workflow_run_failed", headline: `A Workflow you ran for C-${a.number} failed` }] });
  });

  test("a run cancelled in Falcon is Cancelled, and nobody is notified", async () => {
    const a = await acme();
    await a.runner.tick();
    const { body } = await a.run(a.ana, await a.workflowId(), { inputs: { hostname: "FIN-LT-0231" }, caseNumber: a.number });
    await a.runner.tick();
    a.tenant.finish("cancelled");
    a.t.clock.advance(workflowCheckDelayMs(0));
    await a.runner.tick();
    expect((await a.view(body.run!.id)).state).toBe("cancelled");
    expect(await (await a.ana.api.notifications.$get()).json()).toMatchObject({ unread: 0 });
  });

  test("a failed read of the execution is tried again at the next check, and checks slow down", async () => {
    const a = await acme();
    await a.runner.tick();
    const { body } = await a.run(a.ana, await a.workflowId(), { inputs: { hostname: "FIN-LT-0231" }, caseNumber: a.number });
    await a.runner.tick();
    a.tenant.failNextWorkflowCalls = 1;
    a.t.clock.advance(workflowCheckDelayMs(0));
    await a.runner.tick();
    expect(await a.view(body.run!.id)).toMatchObject({ state: "running", error: "Reading workflow executions from Falcon failed: 503" });

    a.t.clock.advance(workflowCheckDelayMs(1) - 1);
    await a.runner.tick();
    expect(a.tenant.executionReads).toHaveLength(0);
    a.t.clock.advance(1);
    await a.runner.tick();
    expect(a.tenant.executionReads).toHaveLength(1);
    expect(await a.view(body.run!.id)).toMatchObject({ state: "running", error: null });
    expect(workflowCheckDelayMs(20)).toBe(5 * 60_000);
  });

  test("Argus stops watching a run Falcon gives no outcome for within 7 days", async () => {
    const a = await acme();
    await a.runner.tick();
    const { body } = await a.run(a.ana, await a.workflowId(), { inputs: { hostname: "FIN-LT-0231" }, caseNumber: a.number });
    await a.runner.tick();
    a.t.clock.advance(WORKFLOW_RUN_WATCH_MS);
    await a.runner.tick();
    expect(await a.view(body.run!.id)).toMatchObject({ state: "timed_out" });
    expect(await (await a.ana.api.notifications.$get()).json()).toMatchObject({ notifications: [{ kind: "workflow_run_failed" }] });
  });

  test("a run Falcon couldn't be asked for is Failed at once, never resent by the worker, and a Member may Retry it", async () => {
    const a = await acme();
    await a.runner.tick();
    a.tenant.refuseWorkflowRuns = "Running a workflow failed: the API client lacks the Workflow: Write scope";
    const { body } = await a.run(a.ana, await a.workflowId(), { inputs: { hostname: "FIN-LT-0231" }, reason: "Reported in #soc" });
    const runId = body.run!.id;
    await a.runner.tick();
    expect(await a.view(runId)).toMatchObject({ state: "failed", executionId: null, retryable: true, error: a.tenant.refuseWorkflowRuns });
    a.t.clock.advance(60 * 60_000);
    await a.runner.tick();
    expect(a.tenant.executions).toHaveLength(0);

    // A run Falcon took and reported failed is run again instead.
    a.tenant.refuseWorkflowRuns = null;
    const [entry] = await a.log();
    expect(entry).toMatchObject({ state: "failed", workflowRun: { id: runId, retryable: true } });
    expect((await a.ana.api["action-log"][":id"].retry.$post({ param: { id: entry!.id } })).status).toBe(200);
    await a.runner.tick();
    expect(a.tenant.executions).toHaveLength(1);
    expect((await a.view(runId)).state).toBe("running");
    expect((await a.ana.api.workflows.runs[":id"].retry.$post({ param: { id: runId } })).status).toBe(409);
  });
});

describe("Who may run what", () => {
  test("only a Workflow that is on demand, on in Falcon and through an Integration with Workflows on and not paused", async () => {
    const a = await acme({ workflowsOn: false });
    await a.runner.tick();
    const id = await a.workflowId();
    expect(await a.run(a.ana, id, { inputs: { hostname: "x" }, caseNumber: a.number })).toMatchObject({ status: 409, body: { error: "Isolate and notify can't be run now: Workflows off" } });
    expect(await a.run(a.ana, await a.workflowId("def-nightly"), { caseNumber: a.number })).toMatchObject({ status: 409 });
    expect(await a.run(a.ana, await a.workflowId("def-off"), { caseNumber: a.number })).toMatchObject({ status: 409 });

    // Turning it on is an Admin's, and recorded.
    expect((await a.ana.api.integrations[":id"].workflows.$put({ param: { id: a.integrationId }, json: { enabled: true } })).status).toBe(403);
    expect((await a.owner.api.integrations[":id"].workflows.$put({ param: { id: a.integrationId }, json: { enabled: true } })).status).toBe(200);
    const audit = await (await a.owner.api.organization["audit-log"].$get({ query: { category: "integrations" } })).json();
    if (!("entries" in audit)) throw new Error("No Audit Log");
    expect(audit.entries[0]).toMatchObject({ action: "integration.workflows_enabled", target: "CrowdStrike — Prod", before: "Workflows off", after: "Workflows on" });
    expect((await a.run(a.ana, id, { inputs: { hostname: "x" }, caseNumber: a.number })).status).toBe(201);

    await a.owner.api.integrations[":id"].pause.$post({ param: { id: a.integrationId } });
    expect(await a.run(a.ana, id, { inputs: { hostname: "x" }, caseNumber: a.number })).toMatchObject({ status: 409, body: { error: "Isolate and notify can't be run now: Paused" } });
  });

  test("a run queued before Workflows were turned off fails without being sent", async () => {
    const a = await acme();
    await a.runner.tick();
    const { body } = await a.run(a.ana, await a.workflowId(), { inputs: { hostname: "x" }, caseNumber: a.number });
    await a.owner.api.integrations[":id"].workflows.$put({ param: { id: a.integrationId }, json: { enabled: false } });
    await a.runner.tick();
    expect(await a.view(body.run!.id)).toMatchObject({ state: "failed", error: "Workflows were turned off for the Integration before this was sent" });
    expect(a.tenant.executions).toHaveLength(0);
  });

  test("inputs must be what the Workflow declares", async () => {
    const a = await acme();
    await a.runner.tick();
    const id = await a.workflowId();
    expect(await a.run(a.ana, id, { inputs: {}, caseNumber: a.number })).toMatchObject({ status: 400, body: { error: "Hostname is required" } });
    expect(await a.run(a.ana, id, { inputs: { hostname: "x", notify: "maybe" }, caseNumber: a.number })).toMatchObject({ status: 400, body: { error: "Notify: give true or false" } });
    expect(await a.run(a.ana, id, { inputs: { hostname: "x", ticket: "INC-1" }, caseNumber: a.number })).toMatchObject({ status: 400, body: { error: "This Workflow takes no ticket" } });
  });

  test("without a Case a reason is required, and the run is recorded in the Organization Audit Log; linking it later moves it to the Case", async () => {
    const a = await acme();
    await a.runner.tick();
    const id = await a.workflowId();
    expect(await a.run(a.ana, id, { inputs: { hostname: "x" } })).toMatchObject({ status: 400 });
    const { status, body } = await a.run(a.ana, id, { inputs: { hostname: "x" }, reason: "Reported in #soc" });
    expect(status).toBe(201);
    const audit = await (await a.owner.api.organization["audit-log"].$get({ query: { category: "workflows" } })).json();
    if (!("entries" in audit)) throw new Error("No Audit Log");
    expect(audit.entries[0]).toMatchObject({ action: "workflow_run.requested", target: "Isolate and notify", actor: { name: "Ana Analyst" } });

    const [entry] = await a.log(a.ana, { link: "unlinked", group: "workflow" });
    expect(entry).toMatchObject({ case: null, detail: "Reported in #soc" });
    expect((await a.ana.api["action-log"][":id"].link.$post({ param: { id: entry!.id }, json: { caseNumber: a.number } })).status).toBe(200);
    expect(await a.view(body.run!.id)).toMatchObject({ case: { number: a.number } });
    expect((await a.log(a.ana, { link: "linked" }))[0]).toMatchObject({ id: entry!.id, case: { number: a.number } });
    expect((await a.caseAudit()).find((e) => e.action === "workflow_run.linked")).toMatchObject({ target: "Isolate and notify" });
    expect((await a.ana.api["action-log"][":id"].link.$post({ param: { id: entry!.id }, json: { caseNumber: a.number } })).status).toBe(409);
  });

  test("a run for a Restricted Case is hidden from Analysts who can't see it", async () => {
    const a = await acme();
    await a.runner.tick();
    const opened = await (await a.owner.api.cases.$post({ json: { title: "Insider", caseType: "insider_threat", severity: "high" } })).json();
    if (!("case" in opened)) throw new Error("Could not open a Case");
    await a.owner.api.cases[":number"].$patch({ param: param(opened.case.number), json: { restricted: true } });
    const { body } = await a.run(a.owner, await a.workflowId(), { inputs: { hostname: "x" }, caseNumber: opened.case.number });
    expect((await a.ana.api.workflows.runs[":id"].$get({ param: { id: body.run!.id } })).status).toBe(404);
    expect(await a.log(a.ana)).toEqual([]);
    expect((await a.ana.api.workflows.runs.$get({ query: {} })).ok).toBe(true);
    expect(await (await a.ana.api.workflows.runs.$get({ query: {} })).json()).toEqual({ runs: [] });
  });
});
