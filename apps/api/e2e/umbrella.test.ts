import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { defaultWebDist } from "../src/config";
import { createResponseActionSender } from "../src/response-actions/sender";
import { createServerApp } from "../src/server-app";
import { buildTestApp } from "../src/test/harness";
import { createUmbrellaHealthChecker } from "../src/umbrella/health";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const PASSWORD = "correct-horse-battery";
const KEY = "umbrella-key-0005";
/** Set to a directory to save screenshots of what the test sees. */
const SHOTS = process.env.E2E_SCREENSHOTS;

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

test("the Owner adds Cisco Umbrella and chooses its list; an Analyst adds a domain to it from a Case and sees which lists hold it", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const account = t.umbrella.account(KEY);
  account.list("Phishing domains", "block");
  const partners = account.list("Partners", "allow");
  account.hold(partners, "invoice-portal.biz", { comment: "Billing partner" });
  const health = createUmbrellaHealthChecker(t.deps, { connect: t.umbrella.connect });
  const sender = createResponseActionSender(t.deps, { umbrella: t.umbrella.connect });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");

    // The Owner adds it with an API key, the worker checks the key, and the Owner chooses the list.
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.goto(`${baseUrl}/settings/integrations`);
    await ownerPage.getByRole("button", { name: "+ Add Cisco Umbrella Integration" }).click();
    const dialog = ownerPage.getByRole("dialog", { name: "Add a Cisco Umbrella Integration" });
    expect(await dialog.getByLabel("Falcon cloud").count()).toBe(0);
    await dialog.getByLabel("Name").fill("Umbrella");
    await dialog.getByLabel("API key").fill(KEY);
    await dialog.getByLabel("Key secret").fill("umbrella-secret");
    await dialog.getByLabel("Response Actions").click();
    await dialog.getByRole("button", { name: "Add Integration" }).click();
    const card = ownerPage.getByTestId("integration-Umbrella");
    await card.getByText("key …0005").waitFor();
    await health.tick();
    await card.getByText("Connected").waitFor();
    const lists = card.getByTestId("destination-list");
    await lists.getByText("None chosen yet").waitFor();
    await lists.getByRole("button", { name: "Choose list" }).click();
    await lists.getByLabel("Umbrella destination list").selectOption({ label: "Phishing domains · Block" });
    await lists.getByRole("button", { name: "Save" }).click();
    await lists.getByText("Phishing domains").waitFor();
    if (SHOTS) await card.screenshot({ path: `${SHOTS}/umbrella-settings.png` });

    await ana.api.cases.$post({ json: { title: "Phishing at Acme", caseType: "phishing", severity: "high" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "domain", value: "invoice-portal.biz" } });

    // Ana adds the domain to the list in one click from its row.
    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1/observables`);
    await page.getByRole("button", { name: "Actions for Domain invoice-portal[.]biz" }).click();
    await page.getByRole("menuitem", { name: "Take action" }).click();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/umbrella-take-action.png` });
    await page.getByRole("group", { name: "Umbrella" }).getByRole("menuitem", { name: /^Add to destination list/ }).click();
    await page.getByText("Add to destination list sent through Umbrella").waitFor();
    const row = page.getByTestId("response-action-invoice-portal.biz");
    await row.getByText("Pending").waitFor();
    await sender.tick();
    await row.getByText("Active").waitFor();
    expect(account.added).toMatchObject([{ destination: "invoice-portal.biz" }]);

    // Its Enrichment says which lists hold it: the one Argus added it to, and the allow list it already was in.
    await page.getByTestId("observable-invoice-portal.biz").getByRole("button", { name: "Show Enrichment for invoice-portal[.]biz" }).click();
    const panel = page.getByRole("dialog", { name: /Enrichment$/ });
    const umbrella = panel.getByRole("region", { name: "Cisco Umbrella" });
    await umbrella.getByText("Phishing domains").waitFor();
    await umbrella.getByText("Partners").waitFor();
    await umbrella.getByText("Billing partner").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/umbrella-enrichment.png` });
  } finally {
    await stop();
  }
}, 60_000);
