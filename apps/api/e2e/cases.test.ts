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
  const serve = (port = 0) => Bun.serve({ port, fetch: (request, bun) => handler(request, bun), websocket });
  let server = serve();
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  return {
    t,
    baseUrl,
    stop: () => server.stop(true),
    /** Drops every connection, live sockets included, until `restart` is called. */
    async interrupt() {
      await server.stop(true);
      return {
        restart: () => {
          server = serve(Number(new URL(baseUrl).port));
        },
      };
    },
  };
}

async function signIn(page: Page, baseUrl: string, email: string, code: () => Promise<string>) {
  await page.goto(`${baseUrl}/sign-in`);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Authentication code").fill(await code());
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("heading", { name: "Cases" }).waitFor();
}

test("an Analyst opens a Case, assigns it, edits the Case Summary past a colleague's save, and reads the Audit Log", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));

    // Open a Case.
    await page.getByRole("button", { name: "+ Open Case" }).click();
    const dialog = page.getByRole("dialog", { name: "Open a Case" });
    await dialog.getByLabel("Title").fill("Suspicious PowerShell on FIN-LT-0231");
    await dialog.getByLabel("Case Type").selectOption("malware");
    await dialog.getByLabel("Severity").selectOption("high");
    await dialog.getByRole("textbox", { name: "Case Summary" }).fill("Falcon flagged encoded PowerShell.");
    await dialog.getByRole("button", { name: "Open Case", exact: true }).click();
    await page.waitForURL(`${baseUrl}/cases/1`);
    await page.getByRole("heading", { name: "Suspicious PowerShell on FIN-LT-0231" }).waitFor();
    await page.getByText("Falcon flagged encoded PowerShell.").waitFor();
    expect(await page.getByLabel("Status").inputValue()).toBe("new");

    // Take it and move it on.
    await page.getByLabel("Assignee").selectOption({ label: "Ana Analyst" });
    await page.getByLabel("Status").selectOption("in_progress");
    await page.getByLabel("Status").and(page.locator(":enabled")).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Suspicious PowerShell on FIN-LT-0231" }).waitFor();
    expect(await page.getByLabel("Status").inputValue()).toBe("in_progress");
    expect(await page.getByLabel("Assignee").locator("option:checked").textContent()).toBe("Ana Analyst");

    // It shows in My Cases.
    await page.getByRole("link", { name: "Cases", exact: true }).first().click();
    await page.getByRole("button", { name: "My Cases (1)" }).waitFor();
    await page.getByRole("link", { name: "Suspicious PowerShell on FIN-LT-0231" }).click();

    // Ana starts editing; Olive saves first; Ana's save is refused and her text kept.
    await page.getByRole("button", { name: "Edit" }).click();
    const editor = page.getByRole("textbox", { name: "Case Summary" });
    await editor.fill("Ana's handover notes.");
    await owner.api.cases[":number"].summary.$put({
      param: { number: "1" },
      json: { version: 1, summary: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Olive's update." }] }] } },
    });
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Not saved — the Case Summary changed since you opened it").waitFor();
    expect(await editor.textContent()).toBe("Ana's handover notes.");
    await page.getByRole("button", { name: "Load current, keep my draft aside" }).click();
    expect(await editor.textContent()).toBe("Olive's update.");
    await page.getByText("Your draft, set aside").waitFor();
    await editor.fill("Olive's update. Ana: memory image requested.");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Last saved by Ana Analyst · v3").waitFor();

    // Everything is in the Audit Log.
    await page.getByRole("link", { name: "Audit Log" }).click();
    for (const action of ["Opened Case", "Changed Assignee", "Changed Status", "Edited Case Summary"]) {
      await page.getByRole("cell", { name: action }).first().waitFor();
    }
    expect(await page.getByRole("cell", { name: "Edited Case Summary" }).count()).toBe(2);
  } finally {
    await stop();
  }
}, 60_000);

test("an Analyst closes a Case with a Resolution and it becomes read-only; the Owner reopens it", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await ana.api.cases.$post({ json: { title: "Credential phishing — finance mailboxes", caseType: "phishing", severity: "high" } });

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1`);
    await page.getByRole("heading", { name: "Credential phishing — finance mailboxes" }).waitFor();

    // Closing needs a Resolution.
    await page.getByRole("button", { name: "Close Case" }).click();
    const dialog = page.getByRole("dialog", { name: "Close Case C-1" });
    await dialog.getByText("The Case becomes read-only. Only an Admin can reopen it.").waitFor();
    expect(await dialog.getByRole("button", { name: "Close Case" }).isDisabled()).toBe(true);
    await dialog.getByLabel("False Positive").check();
    await dialog.getByRole("button", { name: "Close Case" }).click();

    // Read-only, and an Analyst can't reopen.
    await page.getByText("Closed · False Positive").waitFor();
    await page.getByText("only an Admin can reopen it").waitFor();
    for (const field of ["Status", "Severity", "Case Type", "Assignee"]) expect(await page.getByLabel(field).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Edit" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /Reopen/ }).count()).toBe(0);
    await page.getByRole("link", { name: "Cases", exact: true }).first().click();
    await page.getByRole("button", { name: "Closed" }).click();
    await page.getByText("Closed · False Positive").waitFor();

    // The Owner reopens it.
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.goto(`${baseUrl}/cases/1`);
    await ownerPage.getByRole("button", { name: "Reopen to In Progress" }).click();
    await ownerPage.getByRole("button", { name: "Close Case" }).waitFor();
    expect(await ownerPage.getByLabel("Status").inputValue()).toBe("in_progress");
    expect(await ownerPage.getByLabel("Severity").isDisabled()).toBe(false);

    await ownerPage.getByRole("link", { name: "Audit Log" }).click();
    await ownerPage.getByRole("cell", { name: "Reopened Case" }).waitFor();
    await ownerPage.getByRole("cell", { name: "Closed Case" }).waitFor();
  } finally {
    await stop();
  }
}, 60_000);

test("an Analyst marks the Case assigned to them Restricted; a colleague can't see it; the Owner sees it with a lock", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    for (const email of ["ana@acme.example", "ben@acme.example"]) {
      await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    }
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
    await ana.api.cases.$post({ json: { title: "Departing employee bulk download", caseType: "insider_threat", severity: "high" } });

    // Ana takes the Case and marks it Restricted.
    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1`);
    await page.getByRole("heading", { name: "Departing employee bulk download" }).waitFor();
    expect(await page.getByLabel("Restricted").count()).toBe(0);
    await page.getByLabel("Assignee").selectOption({ label: "Ana Analyst" });
    await page.getByRole("checkbox", { name: "Restricted" }).click();
    await page.getByText("· Restricted").waitFor();
    expect(await page.getByRole("checkbox", { name: "Restricted" }).getAttribute("aria-checked")).toBe("true");

    // Ben, another Analyst, finds no trace of it.
    const benPage = await browser.newPage();
    await signIn(benPage, baseUrl, "ben@acme.example", () => t.totpCode(ben.totp.secret));
    await benPage.getByRole("button", { name: "All open (0)" }).click();
    await benPage.getByText("No Cases here.").waitFor();
    await benPage.goto(`${baseUrl}/cases/1`);
    await benPage.getByText("There is no Case C-1 in your Organization.").waitFor();

    // The Owner sees it, locked, in the list, and the change in the Audit Log.
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.getByRole("button", { name: "All open (1)" }).click();
    await ownerPage.getByRole("img", { name: "Restricted" }).waitFor();
    await ownerPage.getByRole("link", { name: "Departing employee bulk download" }).click();
    await ownerPage.getByRole("link", { name: "Audit Log" }).click();
    await ownerPage.getByRole("cell", { name: "Changed Restricted" }).waitFor();
    await ownerPage.getByRole("cell", { name: "Not Restricted" }).waitFor();

    // Ana hands it to Ben: she loses sight of it and lands on the list; Ben now sees it.
    await page.getByLabel("Assignee").selectOption({ label: "Ben Analyst" });
    await page.waitForURL(`${baseUrl}/`);
    await page.getByRole("button", { name: "All open (0)" }).click();
    await page.getByText("No Cases here.").waitFor();
    await benPage.goto(`${baseUrl}/cases/1`);
    await benPage.getByRole("heading", { name: "Departing employee bulk download" }).waitFor();
  } finally {
    await stop();
  }
}, 60_000);

test("Case pages and the Case list refresh live, and show who is viewing the Case", async () => {
  const { t, baseUrl, stop, interrupt } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");

    // Ana watches the list; a Case Olive opens appears without a reload.
    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.getByRole("button", { name: "All open (0)" }).click();
    await page.getByRole("status").getByText("Live").waitFor();
    await owner.api.cases.$post({ json: { title: "Suspicious PowerShell on FIN-LT-0231", caseType: "malware", severity: "high" } });
    await page.getByRole("link", { name: "Suspicious PowerShell on FIN-LT-0231" }).waitFor();
    await page.getByRole("button", { name: "All open (1)" }).waitFor();

    // On the Case page, Ana sees Olive arrive, and Olive's change of Status.
    await page.getByRole("link", { name: "Suspicious PowerShell on FIN-LT-0231" }).click();
    const viewing = page.getByRole("list", { name: "Viewing now" });
    await viewing.getByRole("listitem", { name: "Ana Analyst" }).waitFor();
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.goto(`${baseUrl}/cases/1`);
    await viewing.getByRole("listitem", { name: "Olive Owner" }).waitFor();
    await ownerPage.getByLabel("Status").selectOption("in_progress");
    await page.locator("#case-status").and(page.locator("select:has(option[value=in_progress]:checked)")).waitFor();

    // Olive leaves.
    await ownerPage.close();
    await viewing.getByRole("listitem", { name: "Olive Owner" }).waitFor({ state: "detached" });
    expect(await viewing.getByRole("listitem").count()).toBe(1);

    // Ana's connection drops and she misses a change; reconnecting refetches what she's looking at.
    const outage = await interrupt();
    await page.getByRole("status").getByText("Reconnecting…").waitFor();
    await owner.api.cases[":number"].$patch({ param: { number: "1" }, json: { severity: "critical" } });
    outage.restart();
    await page.getByRole("status").getByText("Reconnected · views refreshed").waitFor({ timeout: 15_000 });
    await page.locator("#case-severity").and(page.locator("select:has(option[value=critical]:checked)")).waitFor();
  } finally {
    await stop();
  }
}, 60_000);
