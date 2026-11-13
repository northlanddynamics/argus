import { websocket } from "@hono/bun";
import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { defaultWebDist } from "../src/config";
import { createServerApp } from "../src/server-app";
import { createHostEnricher } from "../src/crowdstrike/host-enrichment";
import { createStreamWorker } from "../src/crowdstrike/stream-worker";
import { fakeHost } from "../src/test/fake-falcon";
import { buildTestApp } from "../src/test/harness";

/** A host Asset's page has a button to each of its Falcon devices in the console. */
test("a host's page opens its Falcon device, or a menu of them when it is ambiguous", async () => {
  const browser = await chromium.launch();
  let handler: (r: Request, b: Bun.Server<unknown>) => Response | Promise<Response> = () => new Response("", { status: 503 });
  const server = Bun.serve({ port: 0, fetch: (r, b) => handler(r, b), websocket });
  const baseUrl = server.url.origin;
  const t = await buildTestApp({ baseUrl });
  handler = createServerApp(t.deps, defaultWebDist, t.live).fetch;
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", "correct-horse-battery", "Olive Owner");
  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: "c1", clientSecret: "s" } });
  const tenant = t.falcon.tenant("c1");
  const A = "8f1c2b3a4d5e6f708192a3b4c5d6e7f8", B = "0123456789abcdef0123456789abcdef";
  tenant.hosts.set(A, fakeHost(A, { hostname: "FIN-LT-0231" }));
  tenant.hosts.set(B, fakeHost(B, { hostname: "FIN-LT-0231" }));
  tenant.hosts.set("1".repeat(32), fakeHost("1".repeat(32), { hostname: "WS-1" }));
  await owner.api.cases.$post({ json: { title: "x", caseType: "malware", severity: "high" } });
  const h1 = await (await owner.api.cases[":number"].assets.$post({ param: { number: "1" }, json: { type: "host", value: "FIN-LT-0231" } })).json() as any;
  const h2 = await (await owner.api.cases[":number"].assets.$post({ param: { number: "1" }, json: { type: "host", value: "WS-1" } })).json() as any;
  const w = createStreamWorker(t.deps, { connect: t.falcon.connect, workerId: "w1" }); await w.tick();
  const enricher = createHostEnricher(t.deps, { connect: t.falcon.connect });
  await enricher.tick(); await enricher.tick(); await enricher.tick();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/sign-in`);
  await page.getByLabel("Work email").fill("owner@acme.example");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Authentication code").fill(await t.totpCode(owner.totp.secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByText("Acme Security", { exact: true }).waitFor();
  const S = process.env.E2E_SCREENSHOTS;
  await page.goto(`${baseUrl}/assets/${h2.asset.id}`);
  for (let i = 0; i < 5; i++) { await enricher.tick(); await page.waitForTimeout(500); }
  await page.getByRole("link", { name: "Open in Falcon" }).waitFor();
  expect(await page.getByRole("link", { name: "Open in Falcon" }).first().getAttribute("href")).toContain("/hosts/hosts/host/");
  if (S) await page.screenshot({ path: `${S}/host-one.png` });
  await page.goto(`${baseUrl}/assets/${h1.asset.id}`);
  for (let i = 0; i < 5; i++) { await enricher.tick(); await page.waitForTimeout(500); }
  await page.getByRole("button", { name: /Open in Falcon: 2 records/ }).click();
  expect(await page.getByRole("menuitem").count()).toBe(2);
  if (S) await page.screenshot({ path: `${S}/host-many.png` });
  await browser.close(); await w.close(); server.stop(true);
}, 60_000);
