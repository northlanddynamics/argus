import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { defaultWebDist } from "../src/config";
import { createStreamWorker } from "../src/crowdstrike/stream-worker";
import { createServerApp } from "../src/server-app";
import { fakeFalcon } from "../src/test/fake-falcon";
import { buildTestApp } from "../src/test/harness";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const PASSWORD = "correct-horse-battery";

const starting = () => new Response("starting", { status: 503 });

async function serveTestApp() {
  let handler: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response> = starting;
  const server = Bun.serve({ port: 0, fetch: (request, bun) => handler(request, bun), websocket });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  return { t, baseUrl, stop: () => server.stop(true) };
}

async function signIn(page: Page, baseUrl: string, email: string, code: () => Promise<string>) {
  await page.goto(`${baseUrl}/sign-in`);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Authentication code").fill(await code());
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByText("Acme Security", { exact: true }).waitFor();
}

test("the Owner adds a CrowdStrike Integration; its detections appear live in an Analyst's Alert queue, filterable by Severity", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");

    // The Owner adds the Integration.
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.goto(`${baseUrl}/settings/integrations`);
    await ownerPage.getByRole("button", { name: "+ Add CrowdStrike Integration" }).click();
    const dialog = ownerPage.getByRole("dialog", { name: "Add a CrowdStrike Integration" });
    await dialog.getByLabel("Name").fill("CrowdStrike — Prod");
    await dialog.getByLabel("Falcon cloud").selectOption("eu-1");
    await dialog.getByLabel("API client ID").fill("falcon-client-0001");
    await dialog.getByLabel("API client secret").fill("falcon-secret");
    await dialog.getByRole("button", { name: "Add Integration" }).click();
    const card = ownerPage.getByTestId("integration-CrowdStrike — Prod");
    await card.getByText("Connecting").waitFor();
    await card.getByText("client …0001").waitFor();

    // A worker connects; the page shows it live.
    await worker.tick();
    await card.getByText("Connected").waitFor();
    await card.getByText("worker-1").waitFor();

    // Ana watches the Alert queue as detections arrive.
    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.getByRole("link", { name: "Alerts" }).click();
    await page.getByRole("heading", { name: "Alerts" }).waitFor();
    await page.getByText("No Alerts here.").waitFor();

    const stream = falcon.tenant("falcon-client-0001");
    stream.detection("EppDetectionSummaryEvent", "ldt:8c4f:41", {
      Name: "Encoded PowerShell from Office process",
      SeverityName: "Critical",
      Hostname: "FIN-LT-0231",
      UserName: "d.howe",
    });
    stream.detection("EppDetectionSummaryEvent", "ldt:71aa:11", { Name: "PUP installer blocked", SeverityName: "Low", Hostname: "MKT-LT-0110" });
    await page.getByTestId("alert-ldt:8c4f:41").getByText("Encoded PowerShell from Office process").waitFor();
    await page.getByTestId("alert-ldt:71aa:11").waitFor();
    expect(await page.getByTestId("alert-ldt:8c4f:41").getByText("Critical").isVisible()).toBe(true);
    await page.getByText("CrowdStrike — Prod · connected · last event").waitFor();

    await page.getByLabel("Severity").selectOption("critical");
    await page.getByTestId("alert-ldt:71aa:11").waitFor({ state: "detached" });
    await page.getByTestId("alert-ldt:8c4f:41").waitFor();

    // The Owner sees the Integration has had an event.
    await card.getByText("None yet").waitFor({ state: "detached" });
  } finally {
    await stop();
  }
}, 60_000);
