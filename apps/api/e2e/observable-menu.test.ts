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
/** Set to a directory to keep screenshots of the menus. */
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

const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("right-clicking an Observable copies it defanged or fanged, and opens a hash or domain in VirusTotal or a public IP on IPinfo.io", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.cases.$post({ json: { title: "Invoice phish", caseType: "phishing", severity: "high" } });
    const add = (type: "ip" | "domain" | "sha256", value: string) =>
      owner.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type, value } });
    await add("domain", "invoice-portal.biz");
    await add("sha256", SHA256);
    await add("ip", "185.220.101.4");
    await add("ip", "10.20.4.17");

    const context = await browser.newContext({ deviceScaleFactor: SHOTS ? 2 : 1 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    // Nothing leaves the test: the lookup sites answer from here.
    await context.route(/^https:\/\/(www\.virustotal\.com|ipinfo\.io)\//, (route) => route.fulfill({ body: "looked up" }));
    const page = await context.newPage();
    await signIn(page, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    const menu = page.getByRole("menu");
    /** One Escape closes the menu. */
    const closeMenu = async () => {
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
    };
    const clipboard = () => page.evaluate<string>("navigator.clipboard.readText()");

    // A domain on the Case's Observables: both copies, and VirusTotal.
    await page.goto(`${baseUrl}/cases/1/observables`);
    await page.getByRole("link", { name: "Domain invoice-portal[.]biz" }).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy defanged" }).waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/case-domain.png` });
    expect(await menu.getByRole("menuitem", { name: /^Open in/ }).allTextContents()).toEqual(["Open in VirusTotal"]);
    await menu.getByRole("menuitem", { name: "Copy defanged" }).click();
    expect(await clipboard()).toBe("invoice-portal[.]biz");
    await page.getByRole("link", { name: "Domain invoice-portal[.]biz" }).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy fanged" }).click();
    expect(await clipboard()).toBe("invoice-portal.biz");

    // A hash: one copy, as it is, and VirusTotal.
    await page.getByRole("link", { name: `SHA-256 ${SHA256}` }).click({ button: "right" });
    expect(await menu.getByRole("menuitem", { name: /^Copy/ }).allTextContents()).toEqual(["Copy"]);
    const vt = page.waitForEvent("popup");
    await menu.getByRole("menuitem", { name: "Open in VirusTotal" }).click();
    expect((await vt).url()).toBe(`https://www.virustotal.com/gui/file/${SHA256}`);

    // A private IP has nothing to look up outside its network.
    await page.getByRole("link", { name: "IP 10.20.4.17" }).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy" }).waitFor();
    expect(await menu.getByRole("menuitem", { name: "Open in IPinfo.io" }).count()).toBe(0);
    await closeMenu();

    // On an Observable's own page, the value has the menu too.
    await page.getByRole("link", { name: "IP 185.220.101.4" }).click();
    await page.getByRole("heading", { name: "185.220.101.4" }).click({ button: "right" });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/item-ip.png` });
    const ipinfo = page.waitForEvent("popup");
    await menu.getByRole("menuitem", { name: "Open in IPinfo.io" }).click();
    expect((await ipinfo).url()).toBe("https://ipinfo.io/185.220.101.4");

    // In Bulk Lookup an IP has both its Enrichment and the menu.
    await page.goto(`${baseUrl}/lookup`);
    await page.getByLabel("Text to look up").fill("seen 185.220.101.4 and hxxps://invoice-portal[.]biz/pay");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    const ip = page.getByRole("link", { name: "185.220.101.4" });
    await ip.click({ button: "right" });
    await menu.getByRole("menuitem", { name: /^Show Enrichment/ }).click();
    await page.getByRole("dialog", { name: "IP Enrichment" }).waitFor();
    await page.locator("[data-slot=sheet-overlay]").click();
    await ip.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Open in IPinfo.io" }).waitFor();
    await closeMenu();
    // A value Argus doesn't hold yet opens its Enrichment when clicked.
    const url = page.getByRole("button", { name: "hxxps://invoice-portal[.]biz/pay", exact: true });
    await url.click();
    await page.getByRole("dialog", { name: "URL Enrichment" }).waitFor();
    await page.locator("[data-slot=sheet-overlay]").click();
    await url.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy fanged" }).click();
    expect(await clipboard()).toBe("https://invoice-portal.biz/pay");
    await context.close();
  } finally {
    stop();
  }
}, 60_000);

test("an Admin ignores an Observable from its menu wherever it is shown, and from the Enrichment panel; an Analyst can't", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await owner.api.cases.$post({ json: { title: "Invoice phish", caseType: "phishing", severity: "high" } });
    await owner.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "ip", value: "185.220.101.4" } });

    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    const menu = page.getByRole("menu");
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "IP 185.220.101.4" }) });

    // On a Case's Observables, from the row's menu: it asks first.
    await page.goto(`${baseUrl}/cases/1/observables`);
    await page.getByRole("link", { name: "IP 185.220.101.4" }).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Ignore…" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Ignore this IP?" });
    await confirm.getByRole("button", { name: "Ignore" }).click();
    await confirm.waitFor({ state: "detached" });
    await row.getByText("Ignored").waitFor();

    // In the Enrichment panel it shows as Ignored, and can be taken off the list there.
    await row.getByRole("button", { name: /^Show Enrichment for/ }).click();
    const panel = page.getByRole("dialog", { name: "IP Enrichment" });
    await panel.getByText("Ignored", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Stop ignoring" }).click();
    await panel.getByRole("button", { name: "Ignore…" }).waitFor();
    await row.getByText("Ignored").waitFor({ state: "detached" });
    await page.locator("[data-slot=sheet-overlay]").click();

    // In Bulk Lookup, a value Argus doesn't hold yet can be ignored from its menu too.
    await page.goto(`${baseUrl}/lookup`);
    await page.getByLabel("Text to look up").fill("seen hxxps://invoice-portal[.]biz/pay");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    await page.getByRole("button", { name: "hxxps://invoice-portal[.]biz/pay", exact: true }).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Ignore…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Ignore" }).click();
    await page.goto(`${baseUrl}/settings/ignored`);
    await page.getByText("hxxps://invoice-portal[.]biz/pay").waitFor();
    await context.close();

    // An Analyst gets no Ignore.
    const anaContext = await browser.newContext();
    const anaPage = await anaContext.newPage();
    await signIn(anaPage, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await anaPage.goto(`${baseUrl}/cases/1/observables`);
    await anaPage.getByRole("link", { name: "IP 185.220.101.4" }).click({ button: "right" });
    await anaPage.getByRole("menu").getByRole("menuitem", { name: "Copy" }).waitFor();
    expect(await anaPage.getByRole("menu").getByRole("menuitem", { name: /ignor/i }).count()).toBe(0);
    await anaContext.close();
  } finally {
    stop();
  }
}, 60_000);
