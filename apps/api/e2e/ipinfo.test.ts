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
/** Set to a directory to keep screenshots of the Enrichment panel. */
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

test("the Owner adds IPinfo; opening an IP's Enrichment on a Case shows what IPinfo knows about it, and a private one says it isn't looked up", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await ana.api.cases.$post({ json: { title: "Tor exit traffic from FIN-LT-0231", caseType: "unauthorized_access", severity: "high" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "ip", value: "185.220.101.4" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "ip", value: "10.20.4.17" } });
    t.ipinfo.details.set("185.220.101.4", { hostname: "tor-exit-04.example-relay.net", anonymous: true, asName: "Stiftung Erneuerbare Freiheit", asDomain: "stiftung-erneuerbare-freiheit.de" });

    // Before IPinfo is added, an Analyst is told an Admin can add it.
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1/observables`);
    const panel = page.getByRole("complementary", { name: "IP Enrichment" });
    const show = (ip: string) => page.getByRole("button", { name: `Show Enrichment for ${ip}` }).click();
    await page.getByRole("link", { name: "IP 185.220.101.4" }).hover();
    await page.waitForTimeout(600);
    expect(await panel.count()).toBe(0); // Nothing opens on hover.
    await show("185.220.101.4");
    await panel.getByText("your Organization hasn't connected IPinfo").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/d-unconfigured.png` });
    await panel.getByRole("button", { name: "Close" }).click();
    await panel.waitFor({ state: "detached" });

    // The Owner adds it in Settings.
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.goto(`${baseUrl}/settings/integrations`);
    await ownerPage.getByRole("button", { name: "+ Add IPinfo Integration" }).click();
    await ownerPage.getByLabel("API access token").fill("ipinfo-token-7f3a");
    await ownerPage.getByRole("button", { name: "Add Integration" }).click();
    await ownerPage.getByText("IPinfo API token").waitFor();
    expect(await ownerPage.getByRole("button", { name: "+ Add IPinfo Integration" }).count()).toBe(0);
    if (SHOTS) await ownerPage.screenshot({ path: `${SHOTS}/settings.png`, fullPage: true });

    // Now opening the IP's Enrichment looks it up.
    await page.reload();
    await show("185.220.101.4");
    await panel.getByText("Frankfurt am Main, Hesse").waitFor();
    await panel.getByText("tor-exit-04.example-relay.net").waitFor();
    await panel.getByText("Anonymous").waitFor();
    await panel.getByText("AS60729").waitFor();
    await panel.getByText("In 1 Case").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/a-found.png` });
    expect(t.ipinfo.lookups.filter((l) => l.ip === "185.220.101.4")).toHaveLength(1);
    // Its row is marked, and the URL keeps it open across a reload.
    expect(await page.getByTestId("observable-185.220.101.4").evaluate((row) => !!row.querySelector("[data-enrichment-current]"))).toBe(true);
    expect(new URL(page.url()).searchParams.get("enrichment")).toBe("ip:185.220.101.4");
    await page.reload();
    await panel.getByText("Frankfurt am Main, Hesse").waitFor();

    // Refresh asks IPinfo again.
    await panel.getByRole("button", { name: "Refresh 185.220.101.4" }).click();
    await panel.getByText("refreshing…").waitFor({ state: "detached" });
    expect(t.ipinfo.lookups.filter((l) => l.ip === "185.220.101.4")).toHaveLength(2);

    // ↑ ↓ step to the other IP on the Case; a private address is never sent.
    const order = await page.locator("[data-testid^='observable-']").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")));
    // The page beside the panel is dimmed; clicking it closes the panel.
    await page.locator("[data-slot=enrichment-scrim]").click();
    await panel.waitFor({ state: "detached" });
    await show("185.220.101.4");
    const step = order.indexOf("observable-10.20.4.17") > order.indexOf("observable-185.220.101.4") ? "Next (J)" : "Previous (K)";
    await panel.getByRole("button", { name: step }).click();
    await panel.getByText("Private address").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/c-private.png` });
    expect(t.ipinfo.lookups.some((l) => l.ip === "10.20.4.17")).toBe(false);

    // From the keyboard: I on a focused value opens it, Esc closes it and returns focus to the value.
    await panel.getByRole("button", { name: "Close" }).click();
    const link = page.getByRole("link", { name: "IP 185.220.101.4" });
    await link.focus();
    await page.keyboard.press("i");
    await panel.getByText("Frankfurt am Main, Hesse").waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    expect(await page.evaluate<string | null>("document.activeElement?.getAttribute('aria-label')")).toBe("IP 185.220.101.4");

    // The right-click menu opens it too.
    await link.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Show Enrichment/ }).click();
    await panel.getByText("Frankfurt am Main, Hesse").waitFor();

    // The IP's own page shows the details as a card.
    await page.locator("[data-slot=enrichment-scrim]").click();
    await link.click();
    await page.getByText("IP details").waitFor();
    await page.getByText("Stiftung Erneuerbare Freiheit").waitFor();
    expect(await panel.count()).toBe(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/f-page.png`, fullPage: true });
  } finally {
    await stop();
  }
}, 60_000);
