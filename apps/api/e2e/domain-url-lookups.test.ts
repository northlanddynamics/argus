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

const KEY = "ana-virustotal-key-0000000000000a1b2";
const DOMAIN = "invoice-portal.biz";
const EMAIL = "billing@invoice-portal.biz";
const PHISH_URL = "https://invoice-portal.biz/login?next=%2Finvoice";

test("opening the Enrichment of a domain, an email address or a URL on a Case shows what VirusTotal knows; internal names are never sent", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await ana.api["virustotal-key"].$put({ json: { apiKey: KEY } });
    await ana.api.cases.$post({ json: { title: "Invoice phish to Finance", caseType: "phishing", severity: "high" } });
    for (const [type, value] of [
      ["domain", DOMAIN],
      ["email", EMAIL],
      ["url", PHISH_URL],
      ["domain", "fileserver.corp"],
    ] as const) {
      await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type, value } });
    }
    // Six days before the fake clock's now.
    t.virustotal.domains.set(DOMAIN, {
      stats: { malicious: 7, suspicious: 1, undetected: 25, harmless: 60, unsupported: 0, failed: 0 },
      detections: [
        { engine: "BitDefender", result: "phishing" },
        { engine: "Fortinet", result: "phishing" },
        { engine: "Sophos", result: "phishing" },
      ],
      categories: ["phishing", "business"],
      registeredAt: "2025-12-26T00:00:00.000Z",
      registrar: "NameCheap, Inc.",
      dns: [
        { type: "A", value: "185.220.101.4" },
        { type: "MX", value: "mail.invoice-portal.biz" },
        { type: "NS", value: "dns1.registrar-servers.com" },
      ],
      certificate: { issuer: "Let's Encrypt", subject: DOMAIN, validFrom: "2025-12-27T10:00:00.000Z", validUntil: "2026-03-27T10:00:00.000Z" },
      tags: ["dga"],
    });
    t.virustotal.urls.set(PHISH_URL, {
      stats: { malicious: 9, suspicious: 0, undetected: 50, harmless: 30, unsupported: 0, failed: 0 },
      detections: [{ engine: "Sophos", result: "phishing" }],
      title: "Sign in to your account",
      finalUrl: "https://invoice-portal.biz/m365/",
      redirects: [PHISH_URL, "https://invoice-portal.biz/m365/"],
      categories: ["phishing"],
    });

    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1/observables`);
    const popup = page.getByRole("dialog", { name: /Enrichment$/ });
    const show = (value: string) => page.getByRole("button", { name: `Show Enrichment for ${value}` }).click();
    const away = async () => {
      await popup.getByRole("button", { name: "Close" }).click();
      await popup.waitFor({ state: "detached" });
    };

    // A domain: the verdict, and that it was registered days ago.
    await show("invoice-portal[.]biz");
    await popup.getByText("7/93").waitFor();
    await popup.getByText("Newly registered:").waitFor();
    await popup.getByText("NameCheap, Inc.").waitFor();
    await popup.getByText("Let's Encrypt").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-domain.png` });

    // The address it resolves to opens its own Enrichment in the panel; Back returns to the domain.
    await popup.getByRole("button", { name: "185.220.101.4" }).click();
    await popup.getByRole("heading", { name: "IP Enrichment" }).waitFor();
    await popup.getByText("hasn't connected IPinfo").waitFor();
    expect(await popup.getByRole("button", { name: "Next (J)" }).count()).toBe(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-followed.png` });
    await popup.getByRole("button", { name: "Back" }).click();
    await popup.getByText("NameCheap, Inc.").waitFor();
    await away();

    // An email address shows its domain's report, from the same cached answer.
    await show("billing@invoice-portal[.]biz");
    await popup.getByText("Its domain, invoice-portal[.]biz").waitFor();
    await popup.getByText("7/93").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-email.png` });
    await away();
    expect(t.virustotal.domainLookups).toEqual([{ apiKey: KEY, domain: DOMAIN }]);

    // A URL.
    await page.getByRole("button", { name: /^Show Enrichment for hxxps:\/\/invoice-portal/ }).click();
    await popup.getByText("Sign in to your account").waitFor();
    await popup.getByText("hxxps://invoice-portal[.]biz/m365/").waitFor();
    await popup.getByText("9/89").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-url.png` });
    await away();
    expect(t.virustotal.urlLookups).toEqual([{ apiKey: KEY, url: PHISH_URL }]);

    // An internal name is never sent.
    await show("fileserver[.]corp");
    await popup.getByText(".corp names are only meaningful inside a network").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-withheld.png` });
    await away();
    expect(t.virustotal.domainLookups).toHaveLength(1);

    // The domain's own page shows the report as a card.
    await page.getByRole("link", { name: "Domain invoice-portal[.]biz" }).click();
    await page.getByText("dns1[.]registrar-servers[.]com").waitFor();
    // Its records open their own Enrichment in the panel.
    await page.getByRole("button", { name: "185.220.101.4" }).click();
    await popup.getByRole("heading", { name: "IP Enrichment" }).waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-domain-page.png`, fullPage: true });
  } finally {
    await stop();
  }
}, 60_000);
