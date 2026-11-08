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

test("right-clicking an Observable copies it defanged or fanged, and opens a hash in VirusTotal or a public IP on IPinfo.io", async () => {
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
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    // A domain on the Case's Observables: both copies, and nowhere to look it up.
    await page.goto(`${baseUrl}/cases/1/observables`);
    await page.getByRole("link", { name: "Domain invoice-portal[.]biz" }).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy defanged" }).waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/case-domain.png` });
    expect(await menu.getByRole("menuitem", { name: /^Open in/ }).count()).toBe(0);
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
    await page.keyboard.press("Escape");

    // On an Observable's own page, the value has the menu too.
    await page.getByRole("link", { name: "IP 185.220.101.4" }).click();
    await page.getByRole("heading", { name: "185.220.101.4" }).click({ button: "right" });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/item-ip.png` });
    const ipinfo = page.waitForEvent("popup");
    await menu.getByRole("menuitem", { name: "Open in IPinfo.io" }).click();
    expect((await ipinfo).url()).toBe("https://ipinfo.io/185.220.101.4");

    // In Bulk Lookup an IP has both its context popup and the menu.
    await page.goto(`${baseUrl}/lookup`);
    await page.getByLabel("Text to look up").fill("seen 185.220.101.4 and hxxps://invoice-portal[.]biz/pay");
    await page.getByRole("button", { name: "Look up", exact: true }).click();
    const ip = page.getByRole("link", { name: "185.220.101.4" });
    await ip.hover();
    await page.locator("[data-slot=hover-card-content]").waitFor();
    await ip.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Open in IPinfo.io" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("hxxps://invoice-portal[.]biz/pay", { exact: true }).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Copy fanged" }).click();
    expect(await clipboard()).toBe("https://invoice-portal.biz/pay");
    await context.close();
  } finally {
    stop();
  }
}, 60_000);
