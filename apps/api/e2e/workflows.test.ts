import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { defaultWebDist } from "../src/config";
import { createServerApp } from "../src/server-app";
import { fakeFalcon, fakeWorkflow } from "../src/test/fake-falcon";
import { buildTestApp } from "../src/test/harness";
import { createWorkflowRunner, workflowCheckDelayMs } from "../src/workflows/runner";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const starting = () => new Response("starting", { status: 503 });
/** Where to save screenshots of the page, when set. */
const SHOTS = process.env.E2E_SCREENSHOTS;

test("an Analyst runs a Falcon Fusion SOAR workflow for a Case from the Action Center and follows it to its outcome", async () => {
  let handler: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response> = starting;
  const server = Bun.serve({ port: 0, fetch: (request, bun) => handler(request, bun), websocket });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  const falcon = fakeFalcon();
  const tenant = falcon.tenant(CLIENT_ID);
  tenant.workflows.set("def-isolate", fakeWorkflow("def-isolate"));
  tenant.workflows.set("def-nightly", fakeWorkflow("def-nightly", { name: "Nightly sweep", description: "Hunts for stale sensors", onDemand: false, inputs: [] }));
  const runner = createWorkflowRunner(t.deps, { connect: falcon.connect });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    const added = await (await owner.api.integrations.$post({ json: { name: "Falcon US-1", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } })).json();
    if (!("integration" in added)) throw new Error("Could not add an Integration");
    await owner.api.integrations[":id"].workflows.$put({ param: { id: added.integration.id }, json: { enabled: true } });
    const opened = await (await ana.api.cases.$post({ json: { title: "Invoice portal phish", caseType: "phishing", severity: "high" } })).json();
    if (!("case" in opened)) throw new Error("Could not open a Case");
    await runner.tick();

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${baseUrl}/sign-in`);
    await page.getByLabel("Work email").fill("ana@acme.example");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Authentication code").fill(await t.totpCode(ana.totp.secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByText("Acme Security", { exact: true }).waitFor();

    // The Action Center lists the discovered Workflows, and says why the scheduled one can't run.
    await page.getByRole("link", { name: "Actions" }).click();
    await page.getByRole("heading", { name: "Action Center" }).waitFor();
    await page.getByText("Runs on its own trigger").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/workflows.png`, fullPage: true });

    // Run it for the Case, with the input its trigger declares.
    await page.getByRole("button", { name: "Run Isolate and notify through Falcon US-1" }).click();
    const dialog = page.getByRole("dialog", { name: "Isolate and notify" });
    const submit = dialog.getByRole("button", { name: "Run Workflow" });
    await dialog.getByLabel("Hostname").fill("FIN-LT-0231");
    await dialog.getByLabel("Notify").check();
    // With no Case, it needs a reason; link the Case instead.
    expect(await submit.isDisabled()).toBe(true);
    await dialog.getByLabel("Link to a Case").check();
    await dialog.getByText("Invoice portal phish").click();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/workflow-dialog.png` });
    await submit.click();

    // The dialog follows the run: queued, running in Falcon, then its outcome.
    await dialog.getByText("Queued", { exact: true }).waitFor();
    await runner.tick();
    expect(tenant.executions[0]).toMatchObject({ definitionId: "def-isolate", inputs: { hostname: "FIN-LT-0231", notify: true } });
    await dialog.getByText("Running", { exact: true }).waitFor();
    t.clock.advance(workflowCheckDelayMs(0));
    await runner.tick();
    await dialog.getByText("Falcon: In progress").waitFor();
    await dialog.getByText("Contain host").waitFor();
    tenant.finish("completed", { activities: [{ name: "Contain host", status: "Completed" }, { name: "Post to SOC", status: "Completed" }], output: { ticket: "INC-4411" } });
    t.clock.advance(workflowCheckDelayMs(5));
    await runner.tick();
    await dialog.getByText("Falcon: Completed").waitFor();
    await dialog.getByText("Post to SOC").waitFor();
    await dialog.getByText(/INC-4411/).waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/workflow-run.png` });
    await dialog.getByRole("button", { name: "Done" }).click();

    // The Action Log lists the run, for the Case.
    await page.getByRole("tab", { name: /Action Log/ }).click();
    const row = page.getByRole("row", { name: /Isolate and notify.*C-1.*Completed/ });
    await row.waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/workflow-log.png`, fullPage: true });
    await page.close();
  } finally {
    await server.stop(true);
  }
}, 90_000);
