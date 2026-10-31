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

const starting = () => new Response("starting", { status: 503 });

/** Serves the API and the built SPA on a real port, with the test harness's injected fakes. */
async function serveTestApp() {
  let handler: (request: Request) => Response | Promise<Response> = starting;
  const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist).fetch;
  return { t, baseUrl, stop: () => server.stop(true) };
}

test("the Owner accepts their invite, signs in with email and password and sees their Organization", async () => {
  const { t, baseUrl, stop } = await serveTestApp();
  try {
    const inviteLink = await t.inviteOwner("Acme Security", "owner@acme.example");
    const page = await browser.newPage();

    await page.goto(inviteLink);
    await expect(page.getByText("Acme Security").isVisible()).resolves.toBe(true);
    await page.getByLabel("Your name").fill("Olive Owner");
    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
    await page.getByLabel("Confirm password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Set password and sign in" }).click();
    await page.getByRole("heading", { name: "Acme Security" }).waitFor();

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(`${baseUrl}/sign-in`);
    await page.getByLabel("Work email").fill("owner@acme.example");
    await page.getByLabel("Password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Acme Security" }).waitFor();
    expect(page.url()).toBe(`${baseUrl}/`);
  } finally {
    await stop();
  }
}, 60_000);
