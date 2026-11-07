import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accountName, createIdentityEnricher, IDENTITY_ENRICHMENT_UNAVAILABLE } from "./crowdstrike/identity-enrichment";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import { assetFalconIdentities, falconIdentitySnapshots } from "./db/schema";
import { fakeFalcon, fakeIdentity } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const PROD = "falcon-client-0001";
const DANA = "e3a1c9f0-dana";
const DANA_LAB = "7b20d4aa-dana-lab";
const MINUTE = 60_000;
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner and Ben (an Analyst), signed in; a CrowdStrike Integration on US-1, a
 * worker fetching identity Enrichment, and a Case to which Ben adds accounts by hand, all on a fake
 * Falcon whose Identity Protection knows Dana Howe.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
  const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
  type Session = ReturnType<typeof t.session>;

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: PROD, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const tenant = falcon.tenant(PROD);
  tenant.identities.set(DANA, fakeIdentity(DANA));
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const enricher = createIdentityEnricher(t.deps, { connect: falcon.connect });

  const created = await (await ben.api.cases.$post({ json: { title: "Suspicious sign-ins", caseType: "account_compromise", severity: "high" } })).json();
  if (!("case" in created)) throw new Error("Could not open a Case");
  const number = created.case.number;

  /** Adds account `value` to the Case by hand and returns its id. */
  const addAccount = async (value: string) => {
    const body = await (await ben.api.cases[":number"].assets.$post({ param: param(number), json: { type: "account", value } })).json();
    if (!("asset" in body)) throw new Error("Could not add the account");
    return body.asset.id;
  };
  /** The account's page as `as` opens it. */
  const open = async (id: string, as: Session = ben) => {
    const res = await as.api.assets[":id"].$get({ param: { id } });
    const page = await res.json();
    if (!("item" in page)) throw new Error(`No page: ${res.status}`);
    return page.item;
  };
  const refresh = (id: string, as: Session = ben) => as.api.assets[":id"].enrichment.$post({ param: { id } });
  const integration = async () => {
    const list = await (await owner.api.integrations.$get()).json();
    if (!("integrations" in list)) throw new Error("No Integrations");
    return list.integrations[0]!;
  };

  return { t, owner, ben, tenant, enricher, number, addAccount, open, refresh, integration };
}

describe("How an account is looked up in Identity Protection", () => {
  test("by UPN or email with an @, by domain and SAM name for DOMAIN\\user, by SAM name alone otherwise", () => {
    expect(accountName("d.howe@acme.example")).toEqual({ upn: "d.howe@acme.example" });
    expect(accountName("ACME\\d.howe")).toEqual({ domain: "ACME", samAccountName: "d.howe" });
    expect(accountName("d.howe")).toEqual({ samAccountName: "d.howe" });
    expect(accountName("\\d.howe")).toEqual({ samAccountName: "d.howe" });
    expect(accountName("ACME\\")).toEqual({ samAccountName: "ACME" });
  });
});

describe("Identity Enrichment on an account's page", () => {
  test("each account form resolves to its identity, and its Enrichment is shown as of when it was fetched", async () => {
    const a = await acme();
    const { id: integrationId } = await a.integration();
    for (const value of ["d.howe@acme.example", "dana.howe@acme.example", "ACME\\d.howe", "acme.local\\D.Howe", "d.howe"]) {
      const account = await a.addAccount(value);
      const before = await a.open(account);
      expect(before.falconIdentities).toEqual([
        {
          integration: { id: integrationId, name: "CrowdStrike — Prod", enrichmentUnavailable: null },
          ambiguous: false,
          identities: [],
          lookup: { refreshing: true, checkedAt: null, notFound: false, error: null },
        },
      ]);

      await a.enricher.tick();
      const fetchedAt = a.t.clock.now().toISOString();
      const after = await a.open(account);
      expect(after.falconIdentities).toEqual([
        {
          integration: { id: integrationId, name: "CrowdStrike — Prod", enrichmentUnavailable: null },
          ambiguous: false,
          identities: [
            { entityId: DANA, recordedAt: fetchedAt, enrichment: { refreshing: false, fetchedAt, notFound: false, error: null, identity: fakeIdentity(DANA) } },
          ],
          lookup: null,
        },
      ]);
    }
    expect(a.tenant.identitySearches).toEqual([
      { upn: "d.howe@acme.example" },
      { upn: "dana.howe@acme.example" },
      { domain: "ACME", samAccountName: "d.howe" },
      { domain: "acme.local", samAccountName: "D.Howe" },
      { samAccountName: "d.howe" },
    ]);
  });

  test("an ambiguous bare name records every match, each with its Enrichment", async () => {
    const a = await acme();
    a.tenant.identities.set(DANA_LAB, fakeIdentity(DANA_LAB, { domain: "LAB.ACME.LOCAL", upn: "d.howe@lab.acme.example", email: null }));
    const account = await a.addAccount("d.howe");
    await a.open(account);
    await a.enricher.tick();

    const [group] = (await a.open(account)).falconIdentities;
    expect(group!.ambiguous).toBe(true);
    expect(group!.identities.map((i) => [i.entityId, i.enrichment.identity?.domain])).toEqual([
      [DANA, "ACME.LOCAL"],
      [DANA_LAB, "LAB.ACME.LOCAL"],
    ]);

    // The domain tells them apart.
    const qualified = await a.addAccount("LAB\\d.howe");
    await a.open(qualified);
    await a.enricher.tick();
    const [only] = (await a.open(qualified)).falconIdentities;
    expect(only!.ambiguous).toBe(false);
    expect(only!.identities.map((i) => i.entityId)).toEqual([DANA_LAB]);
  });

  test("once recorded, the entity ID is used and not the name", async () => {
    const a = await acme();
    const account = await a.addAccount("ACME\\d.howe");
    await a.open(account);
    await a.enricher.tick();
    expect(a.tenant.identitySearches).toHaveLength(1);
    expect(a.tenant.identityReads).toEqual([[DANA]]);

    // Renamed in the directory: the name would no longer find it, the entity ID still does.
    a.tenant.identities.set(DANA, fakeIdentity(DANA, { samAccountName: "dana.howe", riskSeverity: "HIGH" }));
    a.t.clock.advance(MINUTE);
    expect((await a.refresh(account)).status).toBe(200);
    await a.enricher.tick();
    expect(a.tenant.identitySearches).toHaveLength(1);
    expect(a.tenant.identityReads).toEqual([[DANA], [DANA]]);
    const [group] = (await a.open(account)).falconIdentities;
    expect(group!.identities[0]!.enrichment.identity).toMatchObject({ samAccountName: "dana.howe", riskSeverity: "HIGH" });
    expect(await a.t.deps.db.select().from(falconIdentitySnapshots).where(eq(falconIdentitySnapshots.entityId, DANA))).toHaveLength(1);
  });

  test("a snapshot younger than 15 minutes is reused, an older one is refetched, and Refresh always refetches", async () => {
    const a = await acme();
    const account = await a.addAccount("d.howe@acme.example");
    await a.open(account);
    await a.enricher.tick();
    expect(a.tenant.identityReads).toHaveLength(1);

    a.t.clock.advance(14 * MINUTE);
    await a.open(account);
    await a.enricher.tick();
    expect(a.tenant.identityReads).toHaveLength(1);

    await a.refresh(account);
    await a.enricher.tick();
    expect(a.tenant.identityReads).toHaveLength(2);

    a.t.clock.advance(16 * MINUTE);
    expect((await a.open(account)).falconIdentities[0]!.identities[0]!.enrichment.refreshing).toBe(true);
    await a.enricher.tick();
    expect(a.tenant.identityReads).toHaveLength(3);
  });

  test("an account Falcon doesn't know shows as not found and is looked up again on the next fetch", async () => {
    const a = await acme();
    const account = await a.addAccount("ACME\\m.unknown");
    await a.open(account);
    await a.enricher.tick();
    const checkedAt = a.t.clock.now().toISOString();
    expect((await a.open(account)).falconIdentities[0]!.lookup).toEqual({ refreshing: false, checkedAt, notFound: true, error: null });

    a.tenant.identities.set("9d0e-m-unknown", fakeIdentity("9d0e-m-unknown", { samAccountName: "m.unknown" }));
    a.t.clock.advance(16 * MINUTE);
    await a.open(account);
    await a.enricher.tick();
    const [group] = (await a.open(account)).falconIdentities;
    expect(group!.lookup).toBeNull();
    expect(group!.identities.map((i) => i.entityId)).toEqual(["9d0e-m-unknown"]);
  });

  test("an identity Falcon no longer knows shows as not found; a failed fetch keeps the last snapshot and says why", async () => {
    const a = await acme();
    const account = await a.addAccount("d.howe");
    await a.open(account);
    await a.enricher.tick();
    const fetchedAt = a.t.clock.now().toISOString();

    a.tenant.failNextIdentityCalls = 1;
    a.t.clock.advance(MINUTE);
    await a.refresh(account);
    await a.enricher.tick();
    const failed = (await a.open(account)).falconIdentities[0]!.identities[0]!.enrichment;
    expect(failed).toEqual({ refreshing: false, fetchedAt, notFound: false, error: "Reading identities from Falcon failed: 503", identity: fakeIdentity(DANA) });
    expect((await a.integration()).identityEnrichmentError).toBeNull();

    a.tenant.identities.delete(DANA);
    await a.refresh(account);
    await a.enricher.tick();
    expect((await a.open(account)).falconIdentities[0]!.identities[0]!.enrichment).toMatchObject({ notFound: true, identity: null, error: null });
  });

  test("a missing scope or licence shows in Integration health and nothing else breaks", async () => {
    const a = await acme();
    a.tenant.refuseIdentities = "access denied, authorization failed";
    const account = await a.addAccount("d.howe");
    await a.open(account);
    await a.enricher.tick();

    const integration = await a.integration();
    expect(integration.identityEnrichmentError).toBe(IDENTITY_ENRICHMENT_UNAVAILABLE);
    expect(integration.hostEnrichmentError).toBeNull();
    expect(integration.health).toBe("connected");
    const [group] = (await a.open(account)).falconIdentities;
    expect(group!.integration.enrichmentUnavailable).toBe(IDENTITY_ENRICHMENT_UNAVAILABLE);
    expect(group!.lookup).toMatchObject({ notFound: false, error: IDENTITY_ENRICHMENT_UNAVAILABLE });

    // Once it is granted, the next lookup works and the health clears.
    a.tenant.refuseIdentities = null;
    await a.refresh(account);
    await a.enricher.tick();
    expect((await a.integration()).identityEnrichmentError).toBeNull();
    expect((await a.open(account)).falconIdentities[0]!.identities[0]!.enrichment.identity).toEqual(fakeIdentity(DANA));
  });

  test("associated endpoints are listed by hostname and never linked to the Case", async () => {
    const a = await acme();
    const account = await a.addAccount("d.howe");
    await a.open(account);
    await a.enricher.tick();
    expect((await a.open(account)).falconIdentities[0]!.identities[0]!.enrichment.identity!.endpoints).toEqual(["FIN-LT-0231"]);
    const assets = await (await a.ben.api.cases[":number"].assets.$get({ param: param(a.number) })).json();
    if (!("assets" in assets)) throw new Error("No Assets");
    expect(assets.assets.map((x) => [x.type, x.value])).toEqual([["account", "d.howe"]]);
  });

  test("a paused Integration's lookups wait, and hosts get no identities", async () => {
    const a = await acme();
    const { id } = await a.integration();
    await a.owner.api.integrations[":id"].pause.$post({ param: { id } });
    const account = await a.addAccount("d.howe");
    const host = await (await a.ben.api.cases[":number"].assets.$post({ param: param(a.number), json: { type: "host", value: "d.howe" } })).json();
    if (!("asset" in host)) throw new Error("Could not add the host");
    await a.open(account);
    expect((await a.open(host.asset.id)).falconIdentities).toEqual([]);
    await a.enricher.tick();
    expect(a.tenant.identitySearches).toEqual([]);
    expect((await a.open(account)).falconIdentities[0]!.lookup!.refreshing).toBe(true);
  });

  test("Guests neither see identity Enrichment nor ask for it", async () => {
    const a = await acme();
    const account = await a.addAccount("d.howe");
    await a.owner.api.cases[":number"].guests.$post({ param: param(a.number), json: { email: "k.patel@lawfirm.example", name: "Kim Patel", expiresAt: null } });
    const guest = await a.t.guestSignIn("k.patel@lawfirm.example");

    expect((await a.open(account, guest)).falconIdentities).toEqual([]);
    expect((await a.refresh(account, guest)).status as number).toBe(403);
    await a.enricher.tick();
    expect(a.tenant.identitySearches).toEqual([]);
    expect(await a.t.deps.db.select().from(assetFalconIdentities)).toEqual([]);
  });
});
