import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { defaultWebDist } from "../src/config";
import { createCommentSyncer } from "../src/crowdstrike/comment-sync";
import { createStreamWorker } from "../src/crowdstrike/stream-worker";
import { createResponseActionSender } from "../src/response-actions/sender";
import { createServerApp } from "../src/server-app";
import { fakeFalcon } from "../src/test/fake-falcon";
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

test("an Analyst sends an Observable on a Case to Falcon as a custom IOC; it becomes Active on the Case once sent", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  const falcon = fakeFalcon();
  const sender = createResponseActionSender(t.deps, { connect: falcon.connect });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await owner.api.integrations.$post({
      json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: "falcon-client-0001", clientSecret: "falcon-secret", responseActions: true },
    });
    await ana.api.cases.$post({ json: { title: "Phishing at Acme", caseType: "phishing", severity: "high" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "domain", value: "invoice-portal.biz" } });
    await ana.api.cases[":number"].observables.$post({ param: { number: "1" }, json: { type: "url", value: "https://invoice-portal.biz/login" } });

    const page = await browser.newPage();
    await signIn(page, baseUrl, "ana@acme.example", () => t.totpCode(ana.totp.secret));
    await page.goto(`${baseUrl}/cases/1/observables`);
    await page.getByText("No Response Actions yet.").waitFor();
    // Falcon takes no URL as a custom IOC, so only the domain offers it.
    expect(await page.getByTestId("observable-https://invoice-portal.biz/login").getByRole("button", { name: /Send .* to Falcon/ }).count()).toBe(0);

    await page.getByRole("button", { name: "Send Domain invoice-portal.biz to Falcon" }).click();
    const dialog = page.getByRole("dialog", { name: "Send to Falcon as a custom IOC" });
    expect(await dialog.getByLabel("Prevent").isDisabled()).toBe(true);
    await dialog.getByRole("button", { name: "Send to Falcon" }).click();
    const row = page.getByTestId("response-action-invoice-portal.biz");
    await row.getByText("Pending").waitFor();

    // The worker sends it; the Case shows it live.
    await sender.tick();
    await row.getByText("Active").waitFor();
    await row.getByText(/^Sent /).waitFor();
    expect(falcon.tenant("falcon-client-0001").iocsCreated).toMatchObject([{ type: "domain", value: "invoice-portal.biz", action: "detect" }]);

    // Removed again from the Case: Removing until the worker deletes it in Falcon, then Removed.
    await row.getByRole("button", { name: "Remove the Response Action on invoice-portal.biz" }).click();
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

    // On the Case's Observables, she ticks the domain and the IP and sends them together. Falcon
    // takes no URL, so the URL can't be ticked and says so where Send would be.
    await page.getByRole("tab", { name: "Observables & Assets" }).click();
    await page.getByText("No Response Actions yet.").waitFor();
    expect(await page.getByRole("checkbox", { name: "Select URL https://invoice-portal.biz/login" }).count()).toBe(0);
    await page.getByTestId("observable-https://invoice-portal.biz/login").getByText("Falcon takes no URL").waitFor();
    await page.getByRole("checkbox", { name: "Select Domain invoice-portal.biz" }).click();
    await page.getByRole("checkbox", { name: "Select IP 185.220.101.4" }).click();
    await page.getByRole("button", { name: "Send 2 to Falcon" }).click();
    const dialog = page.getByRole("dialog", { name: "Send to Falcon as a custom IOC" });
    // With two Integrations neither is ticked to start with, so where it goes is a choice; she picks Prod.
    const prod = dialog.getByRole("checkbox", { name: "CrowdStrike — Prod" });
    const eu = dialog.getByRole("checkbox", { name: "CrowdStrike — EU" });
    expect(await prod.isChecked()).toBe(false);
    expect(await eu.isChecked()).toBe(false);
    expect(await dialog.getByRole("button", { name: "Send to Falcon" }).isDisabled()).toBe(true);
    await dialog.getByText("Severity High").waitFor();
    await prod.click();
    await dialog.getByRole("list", { name: "Observables to send" }).getByText("Will be sent to CrowdStrike — Prod").first().waitFor();
    await dialog.getByRole("button", { name: "Send to Falcon" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("2 Response Actions taken through CrowdStrike — Prod").waitFor();

    const domainRow = page.getByTestId("response-action-invoice-portal.biz");
    const ipRow = page.getByTestId("response-action-185.220.101.4");
    await domainRow.getByText("Pending").waitFor();
    await ipRow.getByText("Pending").waitFor();

    // The worker sends them to the Prod Integration only; the Case shows them Active live.
    await sender.tick();
    await domainRow.getByText("Active").waitFor();
    await ipRow.getByText("Active").waitFor();

    // Sending the domain again leaves it out: it is already sent from this Case to Prod.
    await page.getByRole("button", { name: "Send Domain invoice-portal.biz to Falcon" }).click();
    const again = page.getByRole("dialog", { name: "Send to Falcon as a custom IOC" });
    await again.getByRole("checkbox", { name: "CrowdStrike — Prod" }).click();
    await again.getByText("Already sent from this Case as Detect to CrowdStrike — Prod; left out").waitFor();
    expect(await again.getByRole("button", { name: "Send to Falcon" }).isDisabled()).toBe(true);
    await again.getByRole("button", { name: "Cancel" }).click();
    await page.getByTestId("observable-invoice-portal.biz").getByText("Detect · CrowdStrike — Prod, sent").waitFor();
    expect(falcon.tenant("falcon-client-0001").iocsCreated.map((i) => i.value)).toEqual(["invoice-portal.biz", "185.220.101.4"]);
    expect(falcon.tenant("falcon-client-0002").iocsCreated).toEqual([]);

    // The domain's page now lists it, with the Integration and the Case.
    await page.goto(observableUrl);
    const row = actionsOnPage.getByRole("row").filter({ hasText: "Falcon custom IOC" });
    await row.getByText("Active").waitFor();
    await row.getByText("CrowdStrike — Prod").waitFor();
    await row.getByRole("link", { name: /C-1 Invoice phishing wave/ }).waitFor();
  } finally {
    await stop();
  }
}, 60_000);
