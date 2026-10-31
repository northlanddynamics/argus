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

test("the Owner invites an Analyst, promotes them, and sees both in the Organization Audit Log", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    const page = await browser.newPage();
    await signIn(page, baseUrl, "owner@acme.example", () => t.totpCode(owner.totp.secret));

    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByLabel("Invite by email").fill("ana@acme.example");
    await page.getByRole("button", { name: "Send invite" }).click();
    await page.getByTestId("invitation-ana@acme.example").getByText("Invited · pending").waitFor();

    await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    await page.reload();
    const role = page.getByLabel("Role of Ana Analyst");
    await role.waitFor();
    expect(await role.inputValue()).toBe("analyst");
    await role.selectOption("admin");
    await page.getByRole("link", { name: "Organization Audit Log" }).click();
    await page.getByRole("cell", { name: "Changed role of Ana Analyst" }).waitFor();
    await page.getByRole("cell", { name: "Invited ana@acme.example" }).waitFor();

    // Analysts don't see Settings and are sent home if they go there directly.
    const analystEmail = "bo@acme.example";
    await owner.api.organization.invitations.$post({ json: { email: analystEmail, role: "analyst" } });
    const bo = await t.acceptInvite(analystEmail, PASSWORD, "Bo Analyst");
    const analystPage = await browser.newPage();
    await signIn(analystPage, baseUrl, analystEmail, () => t.totpCode(bo.totp.secret));
    expect(await analystPage.getByRole("link", { name: "Settings" }).count()).toBe(0);
    await analystPage.goto(`${baseUrl}/settings/audit-log`);
    await analystPage.waitForURL(`${baseUrl}/`);
  } finally {
    await stop();
  }
}, 60_000);
