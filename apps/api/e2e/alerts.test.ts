import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { defaultWebDist } from "../src/config";
import { createCommentSyncer } from "../src/crowdstrike/comment-sync";
import { createStreamWorker } from "../src/crowdstrike/stream-worker";
import { createMimecastHealthChecker } from "../src/mimecast/health";
import { createResponseActionSender } from "../src/response-actions/sender";
import { createServerApp } from "../src/server-app";
import { fakeFalcon } from "../src/test/fake-falcon";
import { fakeMimecast } from "../src/test/fake-mimecast";
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

test("the Owner adds a CrowdStrike Integration; its detections appear live in an Analyst's Alert queue, filterable by Severity", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");

    // The Owner adds the Integration.
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.goto(`${baseUrl}/settings/integrations`);
    await ownerPage.getByRole("button", { name: "+ Add CrowdStrike Integration" }).click();
    const dialog = ownerPage.getByRole("dialog", { name: "Add a CrowdStrike Integration" });
    await dialog.getByLabel("Name").fill("CrowdStrike — Prod");
    await dialog.getByLabel("Falcon cloud").selectOption("eu-1");
    await dialog.getByLabel("API client ID").fill("falcon-client-0001");
    await dialog.getByLabel("API client secret").fill("falcon-secret");
    await dialog.getByRole("button", { name: "Add Integration" }).click();
    const card = ownerPage.getByTestId("integration-CrowdStrike — Prod");
    await card.getByText("Connecting").waitFor();
    await card.getByText("client …0001").waitFor();

    // A worker connects; the page shows it live.
    await worker.tick();
    await card.getByText("Connected").waitFor();
    await card.getByRole("button", { name: "Stream details" }).click();
    await card.getByText("worker-1").waitFor();

    // Ana watches the Alert queue as detections arrive.
    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.getByRole("link", { name: "Alerts" }).click();
    await page.getByRole("heading", { name: "Alerts" }).waitFor();
    await page.getByText("No New Alerts").waitFor();

    const stream = falcon.tenant("falcon-client-0001");
    stream.detection("EppDetectionSummaryEvent", "ldt:8c4f:41", {
      Name: "Encoded PowerShell from Office process",
      SeverityName: "Critical",
      Hostname: "FIN-LT-0231",
      UserName: "d.howe",
    });
    stream.detection("EppDetectionSummaryEvent", "ldt:71aa:11", { Name: "PUP installer blocked", SeverityName: "Low", Hostname: "MKT-LT-0110" });
    await page.getByTestId("alert-ldt:8c4f:41").getByText("Encoded PowerShell from Office process").waitFor();
    await page.getByTestId("alert-ldt:71aa:11").waitFor();
    expect(await page.getByTestId("alert-ldt:8c4f:41").getByText("Critical").isVisible()).toBe(true);
    await page.getByText("CrowdStrike — Prod: Connected, last event").waitFor();

    await page.getByLabel("Severity").selectOption("critical");
    await page.getByTestId("alert-ldt:71aa:11").waitFor({ state: "detached" });
    await page.getByTestId("alert-ldt:8c4f:41").waitFor();

    // The Owner sees the Integration has had an event.
    await card.getByText("None yet").waitFor({ state: "detached" });

    // The Owner allows Response Actions and sets what one-click IOCs go with.
    await card.getByRole("switch", { name: "Response Actions" }).click();
    await ownerPage.getByRole("alertdialog").getByRole("button", { name: "Allow Response Actions" }).click();
    const defaults = card.getByRole("form", { name: "Response Action defaults" });
    await defaults.getByLabel("Severity").selectOption("critical");
    await defaults.getByLabel("macOS").click();
    await defaults.getByRole("button", { name: "Save defaults" }).click();
    await defaults.getByRole("button", { name: "Save defaults" }).and(ownerPage.locator(":disabled")).waitFor();
    expect((await owner.api.integrations.$get().then((r) => r.json())).integrations[0]!.responseActionDefaults).toEqual({
      severity: "critical",
      platforms: ["windows", "linux"],
      internal: false,
    });
  } finally {
    await stop();
  }
}, 60_000);

test("an Analyst bulk-attaches Alerts to a Case, is told which changed meanwhile, then opens a Case from the rest", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: "falcon-client-0001", clientSecret: "s" } });
    await worker.tick();
    const stream = falcon.tenant("falcon-client-0001");
    stream.detection("EppDetectionSummaryEvent", "ldt:1", { Name: "Encoded PowerShell from Office process", SeverityName: "High" });
    stream.detection("EppDetectionSummaryEvent", "ldt:2", { Name: "Credential dumping attempt", SeverityName: "High" });
    stream.detection("EppDetectionSummaryEvent", "ldt:3", { Name: "Suspicious outbound connection", SeverityName: "Medium" });
    stream.detection("EppDetectionSummaryEvent", "ldt:4", { Name: "Unusual sign-in location", SeverityName: "Critical" });
    await stream.drained();
    const opened = await (await ana.api.cases.$post({ json: { title: "PowerShell on FIN-LT-0231", caseType: "malware", severity: "high" } })).json();
    if (!("case" in opened)) throw new Error("Could not open a Case");
    const number = opened.case.number;

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/alerts`);
    for (const id of ["ldt:1", "ldt:2", "ldt:3"]) await page.getByLabel(`Select ${id}`).check();
    await page.getByText("3 selected").waitFor();

    // Falcon updates one of them after it was selected.
    stream.detection("EppDetectionSummaryEvent", "ldt:2", { Name: "Credential dumping attempt", SeverityName: "Critical" });
    await stream.drained();

    await page.getByRole("toolbar", { name: "Selected Alerts" }).getByRole("button", { name: "Attach to Case…" }).click();
    const dialog = page.getByRole("dialog", { name: "Attach 3 Alerts to a Case" });
    await dialog.getByLabel("Find a Case").fill(`C-${number}`);
    await dialog.getByText("PowerShell on FIN-LT-0231").click();
    await dialog.getByRole("button", { name: "Attach" }).click();
    await page.getByText("1 of 3 Alerts was not attached to").waitFor();
    await page.getByText("Credential dumping attempt (ldt:2) changed since you selected it: it was updated from Falcon").waitFor();
    await page.getByText(`The other 2 were attached to C-${number}.`).waitFor();
    // The queue shows New Alerts: the attached ones leave it live.
    await page.getByTestId("alert-ldt:1").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Select it again" }).click();
    await page.getByLabel("Select ldt:4").check();
    await page.getByRole("toolbar", { name: "Selected Alerts" }).getByRole("button", { name: "Open Case" }).click();
    const open = page.getByRole("dialog", { name: "Open Case from 2 Alerts" });
    expect(await open.getByLabel("Severity").inputValue()).toBe("critical");
    await open.getByLabel("Title").fill("Credential theft");
    await open.getByRole("button", { name: "Open Case" }).click();
    await page.getByRole("heading", { name: "Credential theft" }).waitFor();
    await page.getByRole("list", { name: "Attached Alerts" }).getByText("Unusual sign-in location").waitFor();
  } finally {
    await stop();
  }
}, 60_000);

test("an Alert shows the Observables and Assets it names; attaching it adds them to the Case as Alert (auto)", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: "falcon-client-0001", clientSecret: "s" } });
    await worker.tick();
    const stream = falcon.tenant("falcon-client-0001");
    stream.detection("EppDetectionSummaryEvent", "ldt:1", {
      Name: "Encoded PowerShell from Office process",
      SeverityName: "High",
      Hostname: "FIN-LT-0231",
      UserName: "d.howe",
      NetworkAccesses: [{ LocalAddress: "10.20.4.17", RemoteAddress: "185.220.101.4", RemotePort: 443 }],
    });
    await stream.drained();
    const opened = await (await ana.api.cases.$post({ json: { title: "PowerShell on FIN-LT-0231", caseType: "malware", severity: "high" } })).json();
    if (!("case" in opened)) throw new Error("Could not open a Case");
    const number = opened.case.number;

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/alerts`);
    await page.getByTestId("alert-ldt:1").getByRole("button", { name: "Encoded PowerShell from Office process" }).click();
    await page.getByRole("region", { name: "Extracted Observables" }).getByText("IP 185.220.101.4").waitFor();
    await page.getByRole("region", { name: "Extracted Assets" }).getByText("Host FIN-LT-0231").waitFor();
    await page.getByRole("region", { name: "Extracted Assets" }).getByText("Account d.howe").waitFor();

    await page.getByLabel("Select ldt:1").check();
    await page.getByRole("toolbar", { name: "Selected Alerts" }).getByRole("button", { name: "Attach to Case…" }).click();
    const dialog = page.getByRole("dialog", { name: "Attach 1 Alert to a Case" });
    await dialog.getByLabel("Find a Case").fill(`C-${number}`);
    await dialog.getByText("PowerShell on FIN-LT-0231").click();
    await dialog.getByRole("button", { name: "Attach" }).click();

    await page.goto(`${baseUrl}/cases/${number}/observables`);
    const row = page.getByTestId("observable-185.220.101.4");
    await row.getByText("Alert (auto)").waitFor();
    await row.getByRole("link", { name: "Encoded PowerShell from Office process" }).click();
    await page.getByRole("region", { name: "Extracted Observables" }).waitFor();

    // Each extracted value opens its own page: the Case it is on, and the Alert that names it.
    await page.getByRole("region", { name: "Extracted Observables" }).getByRole("link", { name: "IP 185.220.101.4" }).click();
    await page.getByRole("heading", { name: "185.220.101.4" }).waitFor();
    await page.getByRole("table", { name: "Linked Cases" }).getByRole("link", { name: new RegExp(`C-${number} `) }).waitFor();
    await page.getByRole("table", { name: "Alerts naming it" }).getByRole("link", { name: "Encoded PowerShell from Office process" }).waitFor();

    // Analysts can't ignore it; once an Admin does, the page says so.
    expect(await page.getByRole("button", { name: "Ignore" }).count()).toBe(0);
    const id = new URL(page.url()).pathname.split("/").pop()!;
    expect((await owner.api.observables[":id"].ignored.$put({ param: { id } })).status).toBe(200);
    await page.getByText("Added to the Ignored list by Olive Owner").waitFor();
  } finally {
    await stop();
  }
}, 60_000);

test("opening an Alert refreshes its Falcon comments without waiting; once attached, they are in the Case's Discussion", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  const comments = createCommentSyncer(t.deps, { connect: falcon.connect });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: "falcon-client-0001", clientSecret: "s" } });
    await worker.tick();
    const stream = falcon.tenant("falcon-client-0001");
    stream.detection("EppDetectionSummaryEvent", "ldt:1", { Name: "Encoded PowerShell from Office process", SeverityName: "High" });
    await stream.drained();
    stream.comment("ldt:1", "Isolated the host from the console.", { author: "jsmith@acme.example" });
    const opened = await (await ana.api.cases.$post({ json: { title: "PowerShell on FIN-LT-0231", caseType: "malware", severity: "high" } })).json();
    if (!("case" in opened)) throw new Error("Could not open a Case");
    const number = opened.case.number;

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/alerts`);
    await page.getByTestId("alert-ldt:1").getByRole("button", { name: "Encoded PowerShell from Office process" }).click();
    const inFalcon = page.getByRole("region", { name: "Comments in Falcon" });
    await inFalcon.getByText("Refreshing from Falcon…").waitFor();
    await comments.tick();
    await inFalcon.getByText("Isolated the host from the console.").waitFor();
    await inFalcon.getByText("CrowdStrike: jsmith@acme.example").waitFor();

    await page.getByLabel("Select ldt:1").check();
    await page.getByRole("toolbar", { name: "Selected Alerts" }).getByRole("button", { name: "Attach to Case…" }).click();
    const dialog = page.getByRole("dialog", { name: "Attach 1 Alert to a Case" });
    await dialog.getByLabel("Find a Case").fill(`C-${number}`);
    await dialog.getByText("PowerShell on FIN-LT-0231").click();
    await dialog.getByRole("button", { name: "Attach" }).click();
    await dialog.waitFor({ state: "hidden" });
    await comments.tick();

    await page.goto(`${baseUrl}/cases/${number}/timeline`);
    const message = page.getByRole("listitem", { name: "Message from CrowdStrike: jsmith@acme.example" });
    await message.getByText("Isolated the host from the console.").waitFor();
    await message.getByText("Synced from Falcon").waitFor();
  } finally {
    await stop();
  }
}, 60_000);

test("an Analyst sends an Observable on a Case to Falcon in one click from its menu, with the Integration's defaults; it becomes Active once sent", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const falcon = fakeFalcon();
  const sender = createResponseActionSender(t.deps, { connect: falcon.connect });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await owner.api.integrations.$post({
      json: {
        name: "CrowdStrike — Prod",
        cloud: "us-1",
        clientId: "falcon-client-0001",
        clientSecret: "falcon-secret",
        responseActions: true,
        responseActionDefaults: { severity: "low", platforms: ["windows", "linux"], internal: false },
      },
    });
    await ana.api.cases.$post({ json: { title: "Phishing at Acme", caseType: "phishing", severity: "high" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "domain", value: "invoice-portal.biz" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "url", value: "https://invoice-portal.biz/login" } });

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1/observables`);
    await page.getByText("No Response Actions yet.").waitFor();
    // Falcon takes no URL as a custom IOC: right-clicking it says so under Take action.
    await page.getByTestId("observable-https://invoice-portal.biz/login").getByRole("cell").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Take action" }).click();
    expect(await page.getByRole("menuitem", { name: "Falcon takes no URL" }).isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // The domain's ⋯ menu: an alert in one click, with the Integration's defaults; a block is for hashes.
    await page.getByRole("button", { name: "Actions for Domain invoice-portal[.]biz" }).click();
    await page.getByRole("menuitem", { name: "Take action" }).click();
    const prod = page.getByRole("group", { name: "CrowdStrike — Prod" });
    await prod.getByText("Severity Low · Windows, Linux").waitFor();
    expect(await prod.getByRole("menuitem", { name: /^IOC block/ }).getAttribute("aria-disabled")).toBe("true");
    await prod.getByRole("menuitem", { name: /^IOC alert/ }).click();
    await page.getByText("IOC alert sent through CrowdStrike — Prod").waitFor();
    const row = page.getByTestId("response-action-invoice-portal.biz");
    await row.getByText("Pending").waitFor();

    // The worker sends it; the Case shows it live.
    await sender.tick();
    await row.getByText("Active").waitFor();
    await row.getByText(/^Sent /).waitFor();
    expect(falcon.tenant("falcon-client-0001").iocsCreated).toMatchObject([
      { type: "domain", value: "invoice-portal.biz", action: "detect", severity: "low", platforms: ["windows", "linux"] },
    ]);

    // Removed again by right-clicking its row: Removing until the worker deletes it in Falcon, then Removed.
    await row.getByRole("cell").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Take action" }).click();
    await page.getByRole("menuitem", { name: /^Remove IOC/ }).click();
    const confirm = page.getByRole("dialog", { name: "Remove from Falcon" });
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await row.getByText("Removing").waitFor();
    await sender.tick();
    // Removed ones fold away under the table, and are shown on asking.
    await row.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Show 1 removed or dismissed" }).click();
    await row.getByText("Removed", { exact: true }).waitFor();
    expect(falcon.tenant("falcon-client-0001").iocs.size).toBe(0);
  } finally {
    await stop();
  }
}, 60_000);


test("an Analyst pivots from search to an Observable's page and its Case, sends several Observables to Falcon at once, and sees them become Active", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const falcon = fakeFalcon();
  const sender = createResponseActionSender(t.deps, { connect: falcon.connect });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    for (const [name, clientId] of [
      ["CrowdStrike — Prod", "falcon-client-0001"],
      ["CrowdStrike — EU", "falcon-client-0002"],
    ] as const) {
      await owner.api.integrations.$post({ json: { name, cloud: "us-1", clientId, clientSecret: "falcon-secret", responseActions: true } });
      t.clock.advance(1000);
    }
    await ana.api.cases.$post({ json: { title: "Invoice phishing wave", caseType: "phishing", severity: "high" } });
    const link = (type: "domain" | "url" | "ip", value: string) =>
      ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type, value } });
    await link("domain", "invoice-portal.biz");
    await link("url", "https://invoice-portal.biz/login");
    await link("ip", "185.220.101.4");

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));

    // Search finds the domain; its page has no Response Actions yet and leads to the Case.
    await page.keyboard.press("/");
    const palette = page.getByRole("dialog", { name: "Search" });
    await palette.getByRole("combobox", { name: "Search" }).fill("invoice-portal.biz");
    await palette.getByRole("option").filter({ hasText: "invoice-portal[.]biz" }).first().click();
    await page.waitForURL((url) => url.pathname.startsWith("/observables/"));
    const observableUrl = page.url();
    await page.getByRole("heading", { name: "invoice-portal[.]biz" }).waitFor();
    const actionsOnPage = page.getByRole("table", { name: "Response Actions" });
    await actionsOnPage.getByText("No Response Actions taken on it.").waitFor();
    await page.getByRole("table", { name: "Linked Cases" }).getByRole("link", { name: /C-1 Invoice phishing wave/ }).click();
    await page.waitForURL(`${baseUrl}/cases/1`);

    // On the Case's Observables, she ticks the domain and the IP and alerts on them together through
    // Prod, in one click. Falcon takes no URL, so the URL can't be ticked.
    await page.getByRole("tab", { name: "Observables & Assets" }).click();
    await page.getByText("No Response Actions yet.").waitFor();
    expect(await page.getByRole("checkbox", { name: "Select URL https://invoice-portal.biz/login" }).count()).toBe(0);
    await page.getByRole("checkbox", { name: "Select Domain invoice-portal.biz" }).click();
    await page.getByRole("checkbox", { name: "Select IP 185.220.101.4" }).click();
    await page.getByRole("button", { name: "Take action on 2" }).click();
    const bulk = page.getByRole("group", { name: "CrowdStrike — Prod" });
    await bulk.getByText("Severity High (from the Case) · every platform").waitFor();
    // Neither is a hash, so neither can be blocked.
    expect(await bulk.getByRole("menuitem", { name: /^IOC block/ }).getAttribute("aria-disabled")).toBe("true");
    await bulk.getByRole("menuitem", { name: /^IOC alert/ }).click();
    await page.getByText("IOC alert sent through CrowdStrike — Prod").waitFor();

    const domainRow = page.getByTestId("response-action-invoice-portal.biz");
    const ipRow = page.getByTestId("response-action-185.220.101.4");
    await domainRow.getByText("Pending").waitFor();
    await ipRow.getByText("Pending").waitFor();

    // The worker sends them to the Prod Integration only; the Case shows them Active live.
    await sender.tick();
    await domainRow.getByText("Active").waitFor();
    await ipRow.getByText("Active").waitFor();

    // Its menu now says what was sent through Prod, and still offers EU.
    await page.getByTestId("observable-invoice-portal.biz").getByRole("button", { name: "Actions for Domain invoice-portal[.]biz" }).click();
    await page.getByRole("menuitem", { name: "Take action" }).click();
    await page.getByRole("group", { name: "CrowdStrike — Prod" }).getByText(/^IOC alert sent/).waitFor();
    await page.getByRole("group", { name: "CrowdStrike — EU" }).getByRole("menuitem", { name: /^IOC alert/ }).waitFor();
    // More options leaves it out for Prod: it is already sent from this Case there.
    await page.getByRole("menuitem", { name: "More options…" }).click();
    const again = page.getByRole("dialog", { name: "Send to Falcon as a custom IOC" });
    // With two Integrations neither is ticked to start with, so where it goes is a choice.
    expect(await again.getByRole("checkbox", { name: "CrowdStrike — EU" }).isChecked()).toBe(false);
    await again.getByRole("checkbox", { name: "CrowdStrike — Prod" }).click();
    await again.getByText("Already sent from this Case as Detect to CrowdStrike — Prod; left out").waitFor();
    expect(await again.getByRole("button", { name: "Send to Falcon" }).isDisabled()).toBe(true);
    await again.getByRole("button", { name: "Cancel" }).click();
    await again.waitFor({ state: "detached" });
    await page.getByTestId("observable-invoice-portal.biz").getByText("Detect · CrowdStrike — Prod, sent").waitFor();
    expect(falcon.tenant("falcon-client-0001").iocsCreated.map((i) => i.value)).toEqual(["invoice-portal.biz", "185.220.101.4"]);
    expect(falcon.tenant("falcon-client-0002").iocsCreated).toEqual([]);

    // The domain's page now lists it, with the Integration and the Case.
    await page.goto(observableUrl);
    const row = actionsOnPage.getByRole("row").filter({ hasText: "Falcon custom IOC" });
    await row.getByText("Active").waitFor();
    await row.getByText("CrowdStrike — Prod").waitFor();
    await row.getByRole("link", { name: /C-1 Invoice phishing wave/ }).waitFor();

    // There too, right-clicking a Case it is on takes action from that Case: an alert through EU.
    await page.getByRole("table", { name: "Linked Cases" }).getByRole("row").filter({ hasText: "Invoice phishing wave" }).getByRole("cell").last().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Take action" }).click();
    await page.getByRole("group", { name: "CrowdStrike — EU" }).getByRole("menuitem", { name: /^IOC alert/ }).click();
    await page.getByText("IOC alert sent through CrowdStrike — EU").waitFor();
    await sender.tick();
    expect(falcon.tenant("falcon-client-0002").iocsCreated.map((i) => i.value)).toEqual(["invoice-portal.biz"]);
  } finally {
    await stop();
  }
}, 60_000);

test("the Owner adds a Mimecast Integration; an Analyst blocks an email sender's domain from a Case, which links the domain first", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const mimecast = fakeMimecast();
  const health = createMimecastHealthChecker(t.deps, { connect: mimecast.connect });
  const sender = createResponseActionSender(t.deps, { mimecast: mimecast.connect });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");

    // The Owner adds it: no cloud and no write-back to choose; the worker checks its credentials.
    const ownerPage = await browser.newPage();
    await signIn(ownerPage, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));
    await ownerPage.goto(`${baseUrl}/settings/integrations`);
    await ownerPage.getByRole("button", { name: "+ Add Mimecast Integration" }).click();
    const dialog = ownerPage.getByRole("dialog", { name: "Add a Mimecast Integration" });
    expect(await dialog.getByLabel("Falcon cloud").count()).toBe(0);
    expect(await dialog.getByLabel("Write back to Falcon").count()).toBe(0);
    await dialog.getByLabel("Name").fill("Mimecast");
    await dialog.getByLabel("API application client ID").fill("mimecast-app-0003");
    await dialog.getByLabel("API application client secret").fill("mimecast-secret");
    await dialog.getByLabel("Response Actions").click();
    await dialog.getByRole("button", { name: "Add Integration" }).click();
    const card = ownerPage.getByTestId("integration-Mimecast");
    await card.getByText("Connecting").waitFor();
    await health.tick();
    await card.getByText("Connected").waitFor();
    await card.getByText(/^Credentials checked/).waitFor();
    await card.getByText("Block defaults").waitFor();

    await ana.api.cases.$post({ json: { title: "Phishing at Acme", caseType: "phishing", severity: "high" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "email", value: "billing@invoice-portal.biz" } });

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1/observables`);
    await page.getByRole("button", { name: "Actions for Email billing@invoice-portal[.]biz" }).click();
    await page.getByRole("menuitem", { name: "Take action" }).click();
    const group = page.getByRole("group", { name: "Mimecast" });
    await group.getByRole("menuitem", { name: /^Block domain/ }).click();
    await page.getByText("Block domain sent through Mimecast").waitFor();
    await page.getByTestId("observable-invoice-portal.biz").waitFor();
    const row = page.getByTestId("response-action-invoice-portal.biz");
    await row.getByText("Pending").waitFor();

    await sender.tick();
    await row.getByText("Active").waitFor();
    expect(mimecast.account("mimecast-app-0003").created).toMatchObject([{ type: "domain", value: "invoice-portal.biz", appliesTo: "everyone" }]);

    // Removed from its row: Mimecast stops blocking it.
    await row.getByRole("cell").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Take action" }).click();
    await page.getByRole("menuitem", { name: /^Remove block/ }).click();
    await page.getByRole("dialog", { name: "Remove from Mimecast" }).getByRole("button", { name: "Remove" }).click();
    await row.getByText("Removing").waitFor();
    await sender.tick();
    await row.getByText("Removed").waitFor();
    expect(mimecast.account("mimecast-app-0003").blocked.size).toBe(0);
  } finally {
    await stop();
  }
}, 60_000);
