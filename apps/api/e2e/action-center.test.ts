import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { defaultWebDist } from "../src/config";
import { createResponseActionSender } from "../src/response-actions/sender";
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
const CLIENT_ID = "falcon-client-0001";
const starting = () => new Response("starting", { status: 503 });
/** Where to save screenshots of the page, when set. */
const SHOTS = process.env.E2E_SCREENSHOTS;

test("an Analyst blocks a domain from the Action Center with no Case, sees it in the Action Log, and links it to a Case", async () => {
  let handler: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response> = starting;
  const server = Bun.serve({ port: 0, fetch: (request, bun) => handler(request, bun), websocket });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  const falcon = fakeFalcon();
  const sender = createResponseActionSender(t.deps, { connect: falcon.connect });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await owner.api.integrations.$post({
      json: { name: "Falcon US-1", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret", responseActions: true },
    });
    const opened = await (await ana.api.cases.$post({ json: { title: "Invoice portal phish", caseType: "phishing", severity: "high" } })).json();
    if (!("case" in opened)) throw new Error("Could not open a Case");

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${baseUrl}/sign-in`);
    await page.getByLabel("Work email").fill("ana@acme.example");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Authentication code").fill(await t.totpCode(ana.totp.secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByText("Acme Security", { exact: true }).waitFor();

    // The sidebar leads to the Action Center; pasting a value picks out the actions that take it.
    await page.getByRole("link", { name: "Actions" }).click();
    await page.getByRole("heading", { name: "Action Center" }).waitFor();
    await page.getByLabel("Value", { exact: true }).fill("invoice-portal[.]biz");
    await page.getByText("Domain · ").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/actions.png`, fullPage: true });

    // Run IOC alert with no Case: it needs a reason.
    await page.getByRole("button", { name: "Run IOC alert through CrowdStrike · Falcon US-1" }).click();
    const dialog = page.getByRole("dialog", { name: "IOC alert" });
    await dialog.getByLabel("Values · one per line, or paste any text").fill("invoice-portal[.]biz\n185.220.101[.]4\nhxxps://invoice-portal[.]biz/login");
    await dialog.getByText("IOC alert takes no URL").waitFor();
    const submit = dialog.getByRole("button", { name: "IOC alert (2)" });
    expect(await submit.isDisabled()).toBe(true);
    await dialog.getByLabel(/^Reason/).fill("Reported by 14 users");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/dialog.png` });
    await submit.click();
    await page.getByText("IOC alert: 2 values queued, no Case").waitFor();
    await sender.tick();
    expect(falcon.tenant(CLIENT_ID).iocsCreated.map((i) => i.value).toSorted()).toEqual(["185.220.101.4", "invoice-portal.biz"]);

    // The Action Log tab lists the run, live.
    await page.getByRole("tab", { name: /Action Log/ }).click();
    const row = page.getByRole("row", { name: /invoice-portal\[\.\]biz.*Active/ });
    await row.waitFor();
    await expect(row.getByText("“Reported by 14 users”").count()).resolves.toBe(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/log.png`, fullPage: true });

    // Linking it to the Case moves it there.
    await row.getByRole("button", { name: "Link to Case…" }).click();
    const link = page.getByRole("dialog", { name: "Link to a Case" });
    await link.getByText("Invoice portal phish").click();
    await link.getByRole("button", { name: "Link", exact: true }).click();
    await page.getByRole("row", { name: /invoice-portal\[\.\]biz.*C-1/ }).waitFor();
    await page.close();
  } finally {
    await server.stop(true);
  }
}, 60_000);
