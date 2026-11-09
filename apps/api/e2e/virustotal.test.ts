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

const SHA256 = "a3f5c8e1d2b4a6f8e0c2d4b6a8f0e2c4d6b8a0f2e4c6d8b0a2f4e6c8d0b2a4f6";
const MD5 = "9e107d9d372bb6826bd81d3542a419d6";

test("an Analyst adds their own VirusTotal key; opening a hash's Enrichment on a Case shows what VirusTotal knows about the file", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await ana.api.cases.$post({ json: { title: "Invoice attachment detonated on FIN-LT-0231", caseType: "malware", severity: "high" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "sha256", value: SHA256 } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "md5", value: MD5 } });
    t.virustotal.files.set(SHA256, {
      name: "Invoice_0423.pdf.exe",
      names: ["invoice.exe", "scan_0423.exe"],
      size: 482304,
      signature: { signers: "Fake Corp Ltd", verified: "A certificate was explicitly revoked by its issuer." },
      detections: [
        { engine: "BitDefender", result: "Trojan.GenericKD.71342" },
        { engine: "ESET-NOD32", result: "Win32/Emotet.CK" },
        { engine: "Kaspersky", result: "Trojan.Win32.Emotet.gen" },
        { engine: "Microsoft", result: "Trojan:Win32/Emotet!ml" },
      ],
    });
    t.virustotal.unknown.add(MD5);

    // Without a key, Ana is told to add her own.
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1/observables`);
    const popup = page.getByRole("dialog", { name: /Enrichment$/ });
    const show = (hash: string) => page.getByRole("button", { name: `Show Enrichment for ${hash}` }).click();
    await show(SHA256);
    await popup.getByText("No VirusTotal report yet").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-no-key.png` });

    // She adds it in Your settings.
    await popup.getByRole("link", { name: "Add your key in Your settings" }).click();
    await page.getByRole("heading", { name: "Your settings" }).waitFor();
    await page.getByLabel("API key").fill("ana-virustotal-key-0000000000000a1b2");
    await page.getByRole("button", { name: "Save key" }).click();
    await page.getByText("…a1b2").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-settings.png`, fullPage: true });

    // Now opening the hash's Enrichment looks it up with her key.
    await page.goto(`${baseUrl}/cases/1/observables`);
    await show(SHA256);
    await popup.getByText("Invoice_0423.pdf.exe").waitFor();
    await popup.getByText("trojan.emotet/generic").waitFor();
    await popup.getByText("61/69").waitFor();
    // The panel names more engines than the Observable's page does.
    await popup.getByText("Microsoft").waitFor();
    await popup.getByText("and 57 more").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-found.png` });
    expect(t.virustotal.lookups.filter((l) => l.hash === SHA256)).toEqual([{ apiKey: "ana-virustotal-key-0000000000000a1b2", hash: SHA256 }]);

    await popup.getByRole("button", { name: `Refresh ${SHA256}` }).click();
    await popup.getByText("refreshing…").waitFor({ state: "detached" });
    // The panel slides in, so the click can land before "refreshing…" shows: wait for the lookup itself.
    for (let i = 0; i < 50 && t.virustotal.lookups.filter((l) => l.hash === SHA256).length < 2; i++) await page.waitForTimeout(100);
    expect(t.virustotal.lookups.filter((l) => l.hash === SHA256)).toHaveLength(2);

    // A file VirusTotal hasn't seen says so.
    await page.locator("[data-slot=sheet-overlay]").click();
    await show(MD5);
    await popup.getByText("VirusTotal has never seen this file.").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-not-found.png` });
    await popup.getByRole("button", { name: "Close" }).click();
    await popup.waitFor({ state: "detached" });

    // The hash's own page shows the report as a card.
    await page.getByRole("link", { name: `SHA-256 ${SHA256}` }).click();
    await page.getByText("Fake Corp Ltd").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/vt-page.png`, fullPage: true });
  } finally {
    await stop();
  }
}, 60_000);
