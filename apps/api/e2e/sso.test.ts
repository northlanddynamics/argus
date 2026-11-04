import { websocket } from "@hono/bun";
import { afterAll, beforeAll, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { defaultWebDist } from "../src/config";
import { createServerApp } from "../src/server-app";
import { fakeIdp } from "../src/test/fake-idp";
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
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

test("the Owner enables SSO, and a new Analyst signs in through the identity provider", async () => {
  let handler: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response> = starting;
  const server = Bun.serve({ port: 0, fetch: (request, bun) => handler(request, bun), websocket });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  const idp = fakeIdp({ baseUrl });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");

    const admin = await browser.newPage();
    await admin.goto(`${baseUrl}/sign-in`);
    await admin.getByLabel("Work email").fill("owner@acme.example");
    await admin.getByLabel("Password").fill(PASSWORD);
    await admin.getByRole("button", { name: "Continue" }).click();
    await admin.getByLabel("Authentication code").fill(await t.totpCode(owner.totp.secret));
    await admin.getByRole("button", { name: "Verify" }).click();
    await admin.getByText("Acme Security", { exact: true }).waitFor();

    await admin.goto(`${baseUrl}/settings/sso`);
    const card = admin.getByTestId("sso");
    await card.getByText("Not enabled").waitFor();
    await card.getByText(`${baseUrl}/api/auth/sso/saml2/sp/acs/`, { exact: false }).waitFor();
    await card.getByLabel("Email domain").fill("acme.example");
    await card.getByLabel("IdP metadata XML").fill(idp.metadataXml);
    await card.getByLabel("Provision unknown SSO users as Analysts").check();
    await card.getByRole("button", { name: "Enable SSO" }).click();
    await card.getByText("Enabled", { exact: true }).waitFor();
    await card.getByText(idp.entityId).waitFor();

    // A newcomer: the identity provider signs them in and posts its answer back to Argus.
    const newcomer = await (await browser.newContext()).newPage();
    await newcomer.route(`${idp.ssoUrl}?**`, async (route) => {
      const { acsUrl, SAMLResponse, RelayState } = await idp.answer(t.session(), new URL(route.request().url()), { email: "nia@acme.example", name: "Nia Newbie" });
      const fields = Object.entries({ SAMLResponse, RelayState: RelayState ?? "" })
        .map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value)}">`)
        .join("");
      await route.fulfill({
        contentType: "text/html",
        body: `<form method="post" action="${escape(acsUrl)}">${fields}</form><script>document.forms[0].submit()</script>`,
      });
    });
    await newcomer.goto(`${baseUrl}/sign-in`);
    await newcomer.getByLabel("Work email").fill("nia@acme.example");
    await newcomer.getByRole("button", { name: "Sign in with SSO (SAML)" }).click();
    await newcomer.getByText("Acme Security", { exact: true }).waitFor();

    await admin.goto(`${baseUrl}/settings/members`);
    const nia = admin.getByTestId("member-nia@acme.example");
    await nia.getByText("Nia Newbie").waitFor();
    await nia.getByRole("cell", { name: "SSO", exact: true }).waitFor();
    await admin.goto(`${baseUrl}/settings/audit-log`);
    await admin.getByText("Enabled single sign-on").waitFor();
  } finally {
    await server.stop(true);
  }
}, 60_000);

test("someone who isn't a Member is sent back to sign-in with the reason", async () => {
  let handler: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response> = starting;
  const server = Bun.serve({ port: 0, fetch: (request, bun) => handler(request, bun), websocket });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  const idp = fakeIdp({ baseUrl });
  try {
    await t.inviteOwner("Acme Security", "owner@acme.example");
    const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
    await owner.api.sso.$put({ json: { domain: "acme.example", idp: { metadataXml: idp.metadataXml }, provisionAnalysts: false } });

    const page = await browser.newPage();
    await page.route(`${idp.ssoUrl}?**`, async (route) => {
      const { acsUrl, SAMLResponse, RelayState } = await idp.answer(t.session(), new URL(route.request().url()), { email: "eve@acme.example" });
      await route.fulfill({
        contentType: "text/html",
        body: `<form method="post" action="${escape(acsUrl)}"><input type="hidden" name="SAMLResponse" value="${escape(SAMLResponse)}"><input type="hidden" name="RelayState" value="${escape(RelayState ?? "")}"></form><script>document.forms[0].submit()</script>`,
      });
    });
    await page.goto(`${baseUrl}/sign-in`);
    await page.getByLabel("Work email").fill("eve@acme.example");
    await page.getByRole("button", { name: "Sign in with SSO (SAML)" }).click();
    await page.getByText("You aren't a Member yet. Ask an Admin for an invite.").waitFor();

    await page.getByLabel("Work email").fill("eve@globex.example");
    await page.getByRole("button", { name: "Sign in with SSO (SAML)" }).click();
    await page.getByText("Single sign-on isn't set up for this email domain").waitFor();
  } finally {
    await server.stop(true);
  }
}, 60_000);
