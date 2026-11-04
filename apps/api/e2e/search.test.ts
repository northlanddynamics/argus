import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { defaultWebDist } from "../src/config";
import { createServerApp } from "../src/server-app";
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

test("an Analyst searches from the header and finds Cases and Observables, but not a Restricted Case they aren't on", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
    const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
    await owner.api.cases.$post({ json: { title: "Wire fraud attempt on payroll", caseType: "phishing", severity: "high" } });
    await owner.api.cases.$post({ json: { title: "Payroll director under investigation", caseType: "insider_threat", severity: "critical" } });
    await owner.api.cases[":number"].$patch({ param: { number: "2" }, json: { restricted: true } });
    await owner.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "domain", value: "payroll-update.example" } });

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ben@acme.example", () => t.totpCode(ben.totp.secret));
    await page.keyboard.press("/");
    await page.keyboard.type("payroll");
    await page.keyboard.press("Enter");
    await page.waitForURL(`${baseUrl}/search?q=payroll`);
    await page.getByRole("link", { name: "C-1 Wire fraud attempt on payroll" }).waitFor();
    expect(await page.getByText("Payroll director under investigation").count()).toBe(0);

    const box = page.getByRole("searchbox", { name: "Search Cases, Alerts, Observables and Assets" });
    await box.fill("payroll-update.example");
    await box.press("Enter");
    const observables = page.locator("[data-slot=card]", { hasText: "Observables" });
    await observables.getByText("payroll-update[.]example").waitFor();
    await observables.getByRole("link", { name: "C-1 Wire fraud attempt on payroll" }).click();
    await page.getByRole("heading", { name: "Wire fraud attempt on payroll" }).waitFor();
  } finally {
    await stop();
  }
}, 60_000);
