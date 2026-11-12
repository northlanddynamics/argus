import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
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
const WEBHOOK = "https://acme.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/a1b2";

const starting = () => new Response("starting", { status: 503 });

test("the Owner sets the Teams channel webhook, sends a test post, and a new Critical Case is posted", async () => {
  let handler: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response> = starting;
  const server = Bun.serve({ port: 0, fetch: (request, bun) => handler(request, bun), websocket });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");

    const page = await browser.newPage();
    await page.goto(`${baseUrl}/sign-in`);
    await page.getByLabel("Work email").fill("owner@acme.example");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Authentication code").fill(await t.totpCode(owner.totp.secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByText("Acme Security", { exact: true }).waitFor();

    await page.goto(`${baseUrl}/settings/integrations`);
    const card = page.getByTestId("teams-channel");
    await card.getByText("Not set").waitFor();
    await card.getByLabel("Incoming webhook URL").fill(WEBHOOK);
    await card.getByRole("button", { name: "Send test post" }).click();
    await card.getByText("Test post sent. Check the channel.").waitFor();
    await card.getByRole("button", { name: "Save" }).click();
    await card.getByText("Webhook set").waitFor();
    await card.getByText("acme.webhook.office.com/…a1b2").waitFor();

    await owner.api.cases.$post({ json: { title: "Ransomware note on FS-01", caseType: "malware", severity: "critical" } });
    expect(t.teams.posts.map((p) => [p.webhookUrl, p.message.heading])).toEqual([
      [WEBHOOK, "Argus is connected to this channel"],
      [WEBHOOK, "New Critical Case opened"],
    ]);

    await page.goto(`${baseUrl}/settings/audit-log`);
    await page.getByText("Set the webhook of the Teams channel").waitFor();
  } finally {
    await server.stop(true);
  }
}, 60_000);
