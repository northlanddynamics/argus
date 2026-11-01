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

test("an Admin adds a Case Role; an Analyst gives it on a Case, works its Tasks past a colleague's edit, and reads the Audit Log", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    for (const email of ["ana@acme.example", "ben@acme.example"]) {
      await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    }
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
    await ana.api.cases.$post({ json: { title: "Suspicious PowerShell on FIN-LT-0231", caseType: "malware", severity: "critical" } });

    // The Owner adds Forensics to the catalog.
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.goto(`${baseUrl}/settings/members`);
    await ownerPage.getByLabel("New Case Role").fill("Forensics");
    await ownerPage.getByRole("button", { name: "+ New Case Role" }).click();
    await ownerPage.getByTestId("case-role-Forensics").getByText("on 0 Cases").waitFor();

    // Ana gives Ben Forensics on the Case.
    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1`);
    await page.getByRole("button", { name: "+ Assign" }).click();
    await page.getByLabel("Case Role", { exact: true }).selectOption({ label: "Forensics" });
    await page.getByLabel("Member", { exact: true }).selectOption({ label: "Ben Analyst" });
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    await page.getByRole("button", { name: "Take Forensics from Ben Analyst" }).waitFor();

    // She creates a Task for Ben and completes another of her own.
    await page.getByRole("link", { name: "Tasks (0/0)" }).click();
    await page.getByRole("button", { name: "+ New Task" }).click();
    let dialog = page.getByRole("dialog", { name: "New Task" });
    await dialog.getByLabel("Title").fill("Capture memory image");
    await dialog.getByLabel("Description").fill("Before reboot; upload as Evidence");
    await dialog.getByLabel("Owner").selectOption({ label: "Ben Analyst" });
    await dialog.getByLabel("Due date (optional)").fill("2026-01-05");
    await dialog.getByRole("button", { name: "Create Task" }).click();
    await page.getByTestId("task-Capture memory image").getByText("Ben Analyst").waitFor();
    await page.getByRole("button", { name: "+ New Task" }).click();
    dialog = page.getByRole("dialog", { name: "New Task" });
    await dialog.getByLabel("Title").fill("Contain host");
    await dialog.getByRole("button", { name: "Create Task" }).click();
    await page.getByRole("checkbox", { name: "Contain host done" }).click();
    await page.getByText("1 of 2 done").waitFor();
    await page.getByRole("link", { name: "Tasks (1/2)" }).waitFor();

    // Ana starts editing; Olive saves first; Ana's save is refused and she loads the current Task.
    await page.getByRole("button", { name: "Edit Capture memory image" }).click();
    dialog = page.getByRole("dialog", { name: "Edit Task" });
    await dialog.getByLabel("Title").fill("Capture memory image now");
    const listed = await (await owner.api.cases[":number"].tasks.$get({ param: { number: "1" } })).json();
    const memory = "tasks" in listed ? listed.tasks.find((x) => x.title === "Capture memory image")! : null;
    await owner.api.cases[":number"].tasks[":id"].$patch({
      param: { number: "1", id: memory!.id },
      json: { title: "Capture memory image (FIN-LT-0231)", version: 1 },
    });
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.getByText("Not saved — the Task changed since you opened it").waitFor();
    await dialog.getByRole("button", { name: "Load current" }).click();
    expect(await dialog.getByLabel("Title").inputValue()).toBe("Capture memory image (FIN-LT-0231)");
    await dialog.getByLabel("Due date (optional)").fill("2026-01-06");
    await dialog.getByRole("button", { name: "Save" }).click();
    await page.getByTestId("task-Capture memory image (FIN-LT-0231)").getByText("2026-01-06").waitFor();

    // Everything is in the Audit Log.
    await page.getByRole("link", { name: "Audit Log" }).click();
    for (const action of ["Gave Case Role to Ben Analyst", "Created Task Capture memory image", "Completed Task Contain host", "Changed Task due date"]) {
      await page.getByRole("cell", { name: action }).first().waitFor();
    }

    // The catalog counts the Case.
    await ownerPage.reload();
    await ownerPage.getByTestId("case-role-Forensics").getByText("on 1 Case").waitFor();
  } finally {
    await stop();
  }
}, 60_000);

test("an Analyst discusses a Restricted Case, mentioning only people who can see it, then edits and retracts a message", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    for (const email of ["ana@acme.example", "ben@acme.example"]) {
      await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    }
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
    await ana.api.cases.$post({ json: { title: "Executive mailbox access", caseType: "insider_threat", severity: "high" } });
    const me = await (await ana.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    // Restricting is judged on the Case as it was, so she takes it first.
    await ana.api.cases[":number"].$patch({ param: { number: "1" }, json: { assigneeId: me.user.id } });
    const restricted = await ana.api.cases[":number"].$patch({ param: { number: "1" }, json: { restricted: true } });
    expect(restricted.status).toBe(200);

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1`);
    await page.getByRole("link", { name: "Discussion" }).click();
    await page.getByText("No messages yet.").waitFor();

    // "@" offers only those who can see the Restricted Case: not Ben.
    const box = page.getByRole("textbox", { name: "Message" });
    await box.pressSequentially("Memory image is up — @");
    const offered = page.getByRole("listbox", { name: "People who can see this Case" });
    await offered.getByRole("option", { name: "@Olive Owner · Owner" }).waitFor();
    expect(await offered.getByRole("option").allTextContents()).toEqual(["@Ana Analyst · Analyst", "@Olive Owner · Owner"]);
    await box.pressSequentially("Ol");
    expect(await offered.getByRole("option").count()).toBe(1);
    await box.press("Enter");
    expect(await box.inputValue()).toBe("Memory image is up — @Olive Owner ");
    await page.getByRole("button", { name: "Send" }).click();
    const mine = page.getByRole("listitem", { name: "Message from Ana Analyst" });
    await mine.getByText("@Olive Owner").waitFor();
    expect(await box.inputValue()).toBe("");

    // Olive's reply appears live.
    await owner.api.cases[":number"].discussion.$post({ param: { number: "1" }, json: { body: "Thanks, looking now." } });
    await page.getByRole("listitem", { name: "Message from Olive Owner" }).getByText("Thanks, looking now.").waitFor();

    // Ana edits her message, keeping the mention; Olive's has no Edit for her.
    const olives = page.getByRole("listitem", { name: "Message from Olive Owner" });
    expect(await olives.getByRole("button", { name: "Edit" }).count()).toBe(0);
    expect(await olives.getByRole("button", { name: "Retract" }).count()).toBe(0);
    await mine.getByRole("button", { name: "Edit" }).click();
    const editBox = page.getByRole("textbox", { name: "Edit message" });
    expect(await editBox.inputValue()).toBe("Memory image is up — @Olive Owner");
    await editBox.fill("Memory image uploaded as Evidence — @Olive Owner");
    await page.getByRole("button", { name: "Save" }).click();
    await mine.getByText("· edited").waitFor();
    await mine.getByText("@Olive Owner").waitFor();

    // Then retracts it.
    await mine.getByRole("button", { name: "Retract" }).click();
    await mine.getByRole("button", { name: "Retract message" }).click();
    await mine.getByText("Retracted by Ana Analyst. The original is kept in the Audit Log.").waitFor();

    // The Audit Log keeps every version.
    await page.getByRole("link", { name: "Audit Log" }).click();
    for (const action of ["Posted message", "Edited message", "Retracted message"]) await page.getByRole("cell", { name: action }).first().waitFor();
    await page.getByRole("cell", { name: "Memory image is up — @Olive Owner" }).first().waitFor();
    await page.getByRole("cell", { name: "Memory image uploaded as Evidence — @Olive Owner" }).first().waitFor();
  } finally {
    await stop();
  }
}, 60_000);

test("an Analyst writes the Timeline: exact, range and approximate entries, citations, Promotion, a stale edit and a retraction", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    for (const email of ["ana@acme.example", "ben@acme.example"]) {
      await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    }
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
    const number = { number: "1" };
    await ana.api.cases.$post({ json: { title: "Suspicious PowerShell on FIN-LT-0231", caseType: "malware", severity: "critical" } });
    const me = await (await ana.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    await ana.api.cases[":number"].tasks.$post({ param: number, json: { title: "Contain host", ownerId: me.user.id } });
    await ben.api.cases[":number"].discussion.$post({ param: number, json: { body: "Containing host from console now." } });
    await owner.api.cases[":number"].$patch({ param: number, json: { severity: "high" } });

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1`);
    await page.getByRole("link", { name: "Timeline & Discussion" }).click();
    await page.getByText("Nothing on the Timeline yet.").waitFor();
    const form = page.getByRole("form", { name: "Add entry" });
    const entries = page.getByRole("list", { name: "Timeline Entries" });
    const headings = () => entries.getByRole("heading").allTextContents();

    // A range, citing the Task.
    await form.getByRole("button", { name: "Range" }).click();
    await form.getByLabel("From (UTC)").fill("2026-10-28T09:20");
    await form.getByLabel("To (UTC)").fill("2026-10-28T09:47");
    await form.getByLabel("What happened").fill("Beaconing to 185.220.101.4 roughly every 60 s.");
    await form.getByLabel("Cite a Task").selectOption({ label: "Contain host" });
    await form.getByRole("button", { name: "Add entry" }).click();
    const beaconing = page.getByRole("listitem", { name: "Timeline Entry: Beaconing to 185.220.101.4 roughly every 60 s." });
    await beaconing.getByText("Task · Contain host").waitFor();
    expect(await form.getByLabel("What happened").inputValue()).toBe("");

    // An approximate entry, which happened earlier, goes above it.
    await form.getByRole("button", { name: "Approximate" }).click();
    await form.getByLabel("Around (UTC)").fill("2026-10-27T18:00");
    await form.getByLabel("Give or take").selectOption({ label: "± 6 h" });
    await form.getByLabel("What happened").fill("Phishing email delivered to d.howe.");
    await form.getByRole("button", { name: "Add entry" }).click();
    await page.getByRole("listitem", { name: "Timeline Entry: Phishing email delivered to d.howe." }).waitFor();
    expect(await headings()).toEqual(["≈ 2026-10-27 18:00 UTC ± 6 h", "2026-10-28 09:20 → 09:47 UTC"]);

    // Ben's message is Promoted; it links back, and the message shows it's on the Timeline.
    const bens = page.getByRole("listitem", { name: "Message from Ben Analyst" });
    await bens.getByRole("button", { name: "Promote to Timeline" }).click();
    const dialog = page.getByRole("dialog", { name: "Promote to Timeline" });
    expect(await dialog.getByLabel("What happened").inputValue()).toBe("Containing host from console now.");
    await dialog.getByLabel("At (UTC)").fill("2026-10-28T10:02");
    await dialog.getByLabel("What happened").fill("Host network-contained from the Falcon console.");
    await dialog.getByRole("button", { name: "Promote" }).click();
    const contained = page.getByRole("listitem", { name: "Timeline Entry: Host network-contained from the Falcon console." });
    await contained.getByText("Promoted from Discussion message by Ben Analyst").waitFor();
    await bens.getByText("· on the Timeline").waitFor();
    expect(await bens.getByRole("button", { name: "Promote to Timeline" }).count()).toBe(0);
    expect(await headings()).toEqual(["≈ 2026-10-27 18:00 UTC ± 6 h", "2026-10-28 09:20 → 09:47 UTC", "2026-10-28 10:02 UTC"]);

    // Ana starts editing; Ben saves first, so her save is refused until she loads his.
    await contained.getByRole("button", { name: "Edit" }).click();
    const list = await (await ben.api.cases[":number"].timeline.$get({ param: number })).json();
    if (!("entries" in list)) throw new Error("No Timeline");
    const theirs = list.entries.find((e) => e.body.startsWith("Host network-contained"))!;
    await ben.api.cases[":number"].timeline[":id"].$patch({
      param: { ...number, id: theirs.id },
      json: { occurredAt: theirs.occurredAt, body: "Host network-contained (Ben).", citations: [], version: theirs.version },
    });
    const editForm = page.getByRole("form", { name: "Save" });
    await editForm.getByLabel("What happened").fill("Host network-contained (Ana).");
    await editForm.getByRole("button", { name: "Save" }).click();
    await page.getByText("Not saved — the entry changed since you opened it").waitFor();
    await page.getByRole("button", { name: "Load current" }).click();
    expect(await editForm.getByLabel("What happened").inputValue()).toBe("Host network-contained (Ben).");
    await editForm.getByLabel("What happened").fill("Host network-contained from the Falcon console at 10:02.");
    await editForm.getByRole("button", { name: "Save" }).click();
    const edited = page.getByRole("listitem", { name: "Timeline Entry: Host network-contained from the Falcon console at 10:02." });
    await edited.getByText("edited (original in Audit Log)").waitFor();

    // The approximate entry is retracted, with a reason; it stays, struck through.
    const phishing = page.getByRole("listitem", { name: "Timeline Entry: Phishing email delivered to d.howe." });
    await phishing.getByRole("button", { name: "Retract" }).click();
    await phishing.getByLabel("Why retract it? (optional)").fill("wrong recipient");
    await phishing.getByRole("button", { name: "Retract entry" }).click();
    await phishing.getByText("Retracted by Ana Analyst — wrong recipient. Original kept in the Audit Log.").waitFor();
    expect(await phishing.getByRole("button", { name: "Edit" }).count()).toBe(0);

    // From the Audit Log, the Severity change is Promoted.
    await page.getByRole("link", { name: "Audit Log" }).click();
    const severity = page.getByRole("row").filter({ hasText: "Changed Severity" });
    await severity.getByRole("button", { name: "Promote to Timeline" }).click();
    expect(await dialog.getByLabel("What happened").inputValue()).toBe("Changed Severity: Critical → High");
    await dialog.getByRole("button", { name: "Promote" }).click();
    await severity.getByText("On the Timeline").waitFor();
    for (const action of ["Added Timeline Entry", "Promoted to Timeline", "Edited Timeline Entry", "Retracted Timeline Entry"]) {
      await page.getByRole("cell", { name: action }).first().waitFor();
    }
    await page.getByRole("cell", { name: "≈ 2026-10-27 18:00 UTC ± 6 h · Phishing email delivered to d.howe." }).first().waitFor();

    await page.getByRole("link", { name: "Timeline & Discussion" }).click();
    await page.getByText("Promoted from Audit Log (Changed Severity by Olive Owner)").waitFor();
  } finally {
    await stop();
  }
}, 90_000);

test("an Analyst adds Evidence, sees its SHA-256, views and downloads it, and finds each access in the Audit Log", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await ana.api.cases.$post({ json: { title: "Invoice phish", caseType: "phishing", severity: "high" } });

    const page = await browser.newPage({ acceptDownloads: true });
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1`);
    await page.getByRole("link", { name: "Evidence" }).click();
    await page.getByText("No Evidence yet.").waitFor();

    // Add a file; its fingerprint shows.
    const eml = "From: billing@invoice-portal.biz\r\nSubject: Invoice 4471\r\n\r\n<script>alert(1)</script>\r\n";
    const sha256 = new Bun.CryptoHasher("sha256").update(eml).digest("hex");
    await page.getByLabel("Evidence files").setInputFiles({ name: "invoice-4471.eml", mimeType: "message/rfc822", buffer: Buffer.from(eml) });
    const row = page.getByTestId("evidence-invoice-4471.eml");
    await row.getByText(`${sha256.slice(0, 4)}…${sha256.slice(-4)}`).waitFor();
    expect(await row.locator("code").getAttribute("title")).toBe(sha256);
    expect(await page.getByRole("button", { name: /delete|replace/i }).count()).toBe(0);

    // View opens it in a new tab, as text; Download saves it under its own name.
    const [viewer] = await Promise.all([page.waitForEvent("popup"), row.getByRole("link", { name: "View invoice-4471.eml" }).click()]);
    await viewer.waitForLoadState();
    expect(await viewer.locator("body").textContent()).toContain("<script>alert(1)</script>");
    await viewer.close();
    const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("link", { name: "Download invoice-4471.eml" }).click()]);
    expect(download.suggestedFilename()).toBe("invoice-4471.eml");
    expect(await Bun.file((await download.path())!).text()).toBe(eml);

    // Each is in the Audit Log.
    await page.getByRole("link", { name: "Audit Log" }).click();
    for (const action of ["Added Evidence", "Viewed Evidence", "Downloaded Evidence"]) {
      await page.getByRole("cell", { name: action }).first().waitFor();
    }
    await page.getByText(`SHA-256 ${sha256}`).waitFor();
  } finally {
    await stop();
  }
}, 60_000);
