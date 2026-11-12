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
/** Set to a directory to keep screenshots of the page. */
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

test("the Observables page lists the Organization's Observables and its Ignored list, by type and by value", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.cases.$post({ json: { title: "Invoice phish", caseType: "phishing", severity: "high" } });
    const add = (type: "ip" | "domain", value: string) => owner.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type, value } });
    await add("domain", "invoice-portal.biz");
    await add("ip", "185.220.101.4");
    await add("ip", "8.8.8.8");
    await owner.api.observables.ignored.$post({ json: { type: "ip", value: "8.8.8.8", ignored: true } });
    await owner.api.cases[":number"].assets.$post({ param: { number: "1" }, json: { type: "host", value: "DC01" } });
    const host = await (await owner.api.cases[":number"].assets.$get({ param: { number: "1" } })).json();
    if (!("assets" in host)) throw new Error("No Assets");
    await owner.api.assets[":id"].ignored.$put({ param: { id: host.assets[0]!.id } });

    const context = await browser.newContext({ deviceScaleFactor: SHOTS ? 2 : 1, viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/sign-in`);
    await page.getByLabel("Work email").fill("owner@acme.example");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Authentication code").fill(await t.totpCode(owner.totp.secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByText("Acme Security", { exact: true }).waitFor();

    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Observables" }).click();
    const table = page.getByRole("list", { name: "Observables" });
    await table.getByText("invoice-portal[.]biz").waitFor();
    expect(await table.getByRole("listitem").count()).toBe(3);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/observables.png` });

    // As on a Case: resting the pointer on an IP shows its hover card, and its Enrichment opens in the panel.
    await table.getByRole("link", { name: /185\.220\.101\.4/ }).hover();
    await page.getByTestId("ip-hover-card").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/observables-hover.png` });
    await page.mouse.move(0, 0);
    await page.getByTestId("ip-hover-card").waitFor({ state: "detached" });
    await table.getByRole("button", { name: "Show Enrichment for 185.220.101.4" }).click();
    await page.getByRole("dialog", { name: "IP Enrichment" }).waitFor();
    await page.keyboard.press("Escape");

    // Ticking a type narrows the list to it.
    const filters = page.getByRole("navigation", { name: "Filter by type" });
    await filters.getByRole("checkbox", { name: "IP" }).click();
    await page.getByText("2 Observables, newest first").waitFor();
    expect(await table.getByRole("listitem").count()).toBe(2);
    expect(page.url()).toContain("types=ip");

    // So does searching, defanged or not.
    await page.getByRole("searchbox", { name: "Search Observables" }).fill("185.220");
    await page.getByText("1 Observable, newest first").waitFor();
    expect(await table.getByRole("listitem").count()).toBe(1);
    await filters.getByRole("button", { name: "Show every type" }).click();
    await page.getByRole("searchbox", { name: "Search Observables" }).fill("");
    await table.getByText("invoice-portal[.]biz").waitFor();

    // The Ignored tab: Asset types too, and Admins remove entries.
    await page.getByRole("tab", { name: "Ignored" }).click();
    const ignored = page.getByRole("list", { name: "Ignored Observables" });
    await ignored.getByText("DC01").waitFor();
    await ignored.getByText("8.8.8.8").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ignored.png` });
    await filters.getByRole("checkbox", { name: "Host" }).click();
    await ignored.getByText("8.8.8.8").waitFor({ state: "detached" });
    await ignored.getByRole("button", { name: "Stop ignoring DC01" }).click();
    await page.getByText("Nothing ignored matches.").waitFor();

    // Settings no longer has it.
    await page.goto(`${baseUrl}/settings/members`);
    expect(await page.getByRole("navigation", { name: "Organization settings" }).getByRole("link", { name: /Ignored/ }).count()).toBe(0);
    await context.close();
  } finally {
    stop();
  }
}, 60_000);
