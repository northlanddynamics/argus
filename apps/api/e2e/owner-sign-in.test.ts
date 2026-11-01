import { websocket } from "@hono/bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { defaultWebDist } from "../src/config";
import { createServerApp } from "../src/server-app";
import { buildTestApp, totpSecret } from "../src/test/harness";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const starting = () => new Response("starting", { status: 503 });

/** Serves the API and the built SPA on a real port, with the test harness's injected fakes. */
async function serveTestApp() {
  let handler: (request: Request, server: Bun.Server<unknown>) => Response | Promise<Response> = starting;
  const server = Bun.serve({ port: 0, fetch: (request, bun) => handler(request, bun), websocket });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  return { t, baseUrl, stop: () => server.stop(true) };
}

test("the Owner accepts their invite, enrolls in TOTP, signs in with password and code, then with a passkey", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    const inviteLink = await t.inviteOwner("Acme Security", "owner@acme.example");
    const page = await browser.newPage();
    // A software authenticator, so the browser can create and use passkeys without a person.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
    });

    await page.goto(inviteLink);
    await expect(page.getByText("Acme Security").isVisible()).resolves.toBe(true);
    await page.getByLabel("Your name").fill("Olive Owner");
    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
    await page.getByLabel("Confirm password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Set password and sign in" }).click();

    // Forced TOTP enrollment before anything else.
    await page.getByText("Set up two-factor authentication", { exact: true }).waitFor();
    const keyText = page.getByTestId("totp-key").filter({ hasText: /\w/ });
    await keyText.waitFor();
    const key = (await keyText.textContent())!.replaceAll(" ", "");
    const secret = totpSecret(`otpauth://totp/Argus?secret=${key}`);
    await page.getByLabel("Code from app").fill(await t.totpCode(secret));
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await page.getByText("Save your backup codes", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Also add a passkey" }).click();
    await page.getByRole("button", { name: "Passkey added" }).waitFor();
    await page.getByRole("button", { name: "Continue to Argus" }).click();
    await page.getByText("Acme Security", { exact: true }).waitFor();

    // Password sign-in asks for a TOTP code.
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(`${baseUrl}/sign-in`);
    await page.getByLabel("Work email").fill("owner@acme.example");
    await page.getByLabel("Password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("Enter your 6-digit code", { exact: true }).waitFor();
    await page.getByLabel("Authentication code").fill(await t.totpCode(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByText("Acme Security", { exact: true }).waitFor();
    expect(page.url()).toBe(`${baseUrl}/`);

    // The passkey signs in on its own.
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(`${baseUrl}/sign-in`);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByText("Acme Security", { exact: true }).waitFor();
    expect(page.url()).toBe(`${baseUrl}/`);
  } finally {
    await stop();
  }
}, 60_000);
