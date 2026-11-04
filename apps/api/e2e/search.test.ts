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

test("an Analyst searches from anywhere: top results as they type, narrowed by kind, then every result on the results page", async () => {
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

    // "/" opens the search box; results come as he types, the Restricted Case never among them.
    await page.keyboard.press("/");
    const palette = page.getByRole("dialog", { name: "Search" });
    await palette.getByRole("combobox", { name: "Search" }).fill("payr");
    const options = palette.getByRole("option");
    await options.filter({ hasText: "payroll-update[.]example" }).waitFor();
    await options.filter({ hasText: "Wire fraud attempt on payroll" }).waitFor();
    expect(await palette.getByText("Payroll director under investigation").count()).toBe(0);

    // Narrowed to Observables, only the domain is left; Enter opens the Case it is on.
    await palette.getByRole("radio", { name: "Observables" }).or(palette.getByRole("button", { name: "Observables" })).click();
    await options.filter({ hasText: "Wire fraud attempt on payroll" }).waitFor({ state: "detached" });
    await palette.getByRole("combobox", { name: "Search" }).press("Enter");
    await page.waitForURL(`${baseUrl}/cases/1/observables`);

    // The last row opens every result, with the same kinds.
    await page.keyboard.press("Control+k");
    await palette.getByRole("combobox", { name: "Search" }).fill("payroll");
    await options.filter({ hasText: "See all results" }).click();
    await page.waitForURL((url) => url.pathname === "/search" && url.searchParams.get("q") === "payroll" && url.searchParams.get("kinds") === "observables");
    await page.getByRole("region", { name: /Observables/ }).getByRole("link", { name: /payroll-update\[\.\]example/ }).waitFor();
    const toggle = (name: RegExp) => page.getByRole("radio", { name }).or(page.getByRole("button", { name }));
    await toggle(/^Observables/).click();
    await page.waitForURL((url) => !url.searchParams.has("kinds"));
    const casesSection = page.getByRole("region", { name: /Cases/ });
    await casesSection.getByRole("link", { name: /C-1 Wire fraud attempt on payroll/ }).waitFor();
    expect(await page.getByText("Payroll director under investigation").count()).toBe(0);
    await toggle(/^Cases/).click();
    await page.waitForURL((url) => url.searchParams.get("kinds") === "cases");
    await page.getByRole("region", { name: /Observables/ }).waitFor({ state: "detached" });
    await casesSection.getByRole("link", { name: /C-1 Wire fraud attempt on payroll/ }).click();
    await page.getByRole("heading", { name: "Wire fraud attempt on payroll" }).waitFor();
  } finally {
    await stop();
  }
}, 60_000);
