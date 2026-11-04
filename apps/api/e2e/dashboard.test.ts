import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
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

test("an Analyst's dashboard counts the Cases they can see, drills down to the Case list and refreshes live", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
    const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
    await owner.api.cases.$post({ json: { title: "Wire fraud attempt on payroll", caseType: "phishing", severity: "high" } });
    await owner.api.cases.$post({ json: { title: "Payroll director under investigation", caseType: "insider_threat", severity: "critical" } });
    await owner.api.cases[":number"].$patch({ param: { number: "2" }, json: { restricted: true } });
    t.clock.advance(45 * 60_000);
    await owner.api.cases[":number"].$patch({ param: { number: "1" }, json: { status: "triage" } });

    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`${baseUrl}/sign-in`);
    await page.getByLabel("Work email").fill("ben@acme.example");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Authentication code").fill(await t.totpCode(ben.totp.secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByText("Acme Security", { exact: true }).waitFor();

    await page.getByRole("link", { name: "Dashboard" }).click();
    await page.waitForURL(`${baseUrl}/dashboard`);
    const figure = (label: string) => page.getByRole("group", { name: label });
    // The Restricted Critical Case isn't counted for Ben.
    await figure("Open Cases").getByText("1", { exact: true }).waitFor();
    await figure("Open Cases").getByText("0 Critical · 1 unassigned").waitFor();
    await figure("Mean time to acknowledge").getByText("45 min").waitFor();
    await page.screenshot({ path: process.env.DASHBOARD_SCREENSHOT ?? "/dev/null", fullPage: true });

    // Another Member opens a Case: the dashboard refreshes without a reload.
    await owner.api.cases.$post({ json: { title: "Lost laptop", caseType: "data_loss", severity: "high" } });
    await figure("Open Cases").getByText("0 Critical · 2 unassigned").waitFor();

    // A count drills down to the Case list with those filters.
    await page.getByRole("link", { name: "1 High New" }).click();
    await page.waitForURL((url) => url.pathname === "/" && url.searchParams.get("severity") === "high" && url.searchParams.get("status") === "new");
    const list = page.getByRole("table");
    await list.getByRole("link", { name: "Lost laptop" }).waitFor();
    expect(await list.getByRole("link", { name: "Wire fraud attempt on payroll" }).count()).toBe(0);

    // Periods are in the URL.
    await page.goto(`${baseUrl}/dashboard?days=7`);
    await expect(page.getByRole("radio", { name: "7 days" }).getAttribute("aria-checked")).resolves.toBe("true");
  } finally {
    await stop();
  }
});
