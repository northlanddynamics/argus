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

    // Narrowed to Observables, only the domain is left; Enter opens its page, which leads to the Case it is on.
    await palette.getByRole("radio", { name: "Observables" }).or(palette.getByRole("button", { name: "Observables" })).click();
    await options.filter({ hasText: "Wire fraud attempt on payroll" }).waitFor({ state: "detached" });
    await palette.getByRole("combobox", { name: "Search" }).press("Enter");
    await page.waitForURL((url) => url.pathname.startsWith("/observables/"));
    await page.getByRole("heading", { name: "payroll-update[.]example" }).waitFor();
    const linked = page.getByRole("table", { name: "Linked Cases" });
    await linked.getByRole("link", { name: /C-1 Wire fraud attempt on payroll/ }).click();
    await page.waitForURL(`${baseUrl}/cases/1`);

    // The last row opens every result, with the same kinds.
    await page.keyboard.press("Control+k");
    await palette.getByRole("combobox", { name: "Search" }).fill("payroll");
    await options.filter({ hasText: "See all results" }).click();
    await page.waitForURL((url) => url.pathname === "/search" && url.searchParams.get("q") === "payroll" && url.searchParams.get("kinds") === "observables");
    const list = page.getByRole("list", { name: "Results" });
    await list.getByRole("link", { name: /payroll-update\[\.\]example/ }).waitFor();
    expect(await list.getByRole("listitem").count()).toBe(1);
    const toggle = (name: RegExp) => page.getByRole("radio", { name }).or(page.getByRole("button", { name }));
    await toggle(/^Observables/).click();
    await page.waitForURL((url) => !url.searchParams.has("kinds"));
    await list.getByRole("link", { name: /C-1 Wire fraud attempt on payroll/ }).waitFor();
    await page.getByText("1–2 of 2 results").waitFor();
    expect(await page.getByText("Payroll director under investigation").count()).toBe(0);
    await toggle(/^Cases/).click();
    await page.waitForURL((url) => url.searchParams.get("kinds") === "cases");
    await list.getByRole("link", { name: /payroll-update/ }).waitFor({ state: "detached" });
    await list.getByRole("link", { name: /C-1 Wire fraud attempt on payroll/ }).click();
    await page.getByRole("heading", { name: "Wire fraud attempt on payroll" }).waitFor();
  } finally {
    await stop();
  }
}, 60_000);

test("the results page is one list, best first, a page at a time", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    for (let i = 1; i <= 22; i++) {
      await owner.api.cases.$post({ json: { title: `Lure wave ${i}`, caseType: "phishing", severity: "medium" } });
    }
    await owner.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "domain", value: "lure-kit.example" } });

    const page = await browser.newPage();
    await signIn(page, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await page.goto(`${baseUrl}/search?q=lure`);
    const list = page.getByRole("list", { name: "Results" });
    await page.getByText("1–20 of 23 results").waitFor();
    expect(await list.getByRole("listitem").count()).toBe(20);
    await page.getByText("Page 1 of 2").waitFor();

    await page.getByRole("link", { name: "Next" }).click();
    await page.waitForURL((url) => url.searchParams.get("page") === "2");
    await page.getByText("21–23 of 23 results").waitFor();
    expect(await list.getByRole("listitem").count()).toBe(3);
    expect(await page.getByRole("button", { name: "Next" }).isDisabled()).toBe(true);

    // Narrowing the kinds starts again from the first page.
    await page.getByRole("radio", { name: /^Observables/ }).or(page.getByRole("button", { name: /^Observables/ })).click();
    await page.waitForURL((url) => url.searchParams.get("kinds") === "observables" && !url.searchParams.has("page"));
    await page.getByText("1 result", { exact: true }).waitFor();
  } finally {
    await stop();
  }
}, 60_000);
