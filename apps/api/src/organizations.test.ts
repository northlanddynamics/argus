import { describe, expect, test } from "bun:test";
import { buildTestApp } from "./test/harness";

const OWNER = "owner@acme.example";
const OWNER_PASSWORD = "correct-horse-battery";

async function operatorCreatesAcme() {
  const t = await buildTestApp();
  const operator = await t.createOperator();
  const res = await operator.api.operator.organizations.$post({
    json: { name: "Acme Security", ownerEmail: OWNER },
  });
  expect(res.status).toBe(201);
  return { t, operator };
}

describe("Operator creates an Organization and invites its Owner", () => {
  test("the Owner is emailed an invitation link", async () => {
    const { t } = await operatorCreatesAcme();
    expect(t.outbox.messages).toHaveLength(1);
    expect(t.outbox.messages[0]!.to).toBe(OWNER);
    expect(t.outbox.messages[0]!.text).toContain("http://argus.test/invite/");
  });

  test("the invitation names the Organization and the Owner's email", async () => {
    const { t } = await operatorCreatesAcme();
    const res = await t.session().api.invitations[":id"].$get({ param: { id: t.inviteIdFor(OWNER) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: OWNER,
      role: "owner",
      organization: { name: "Acme Security" },
    });
  });

  test("the Owner accepts, sets a password, signs in, enrolls in TOTP and lands in their Organization", async () => {
    const { t } = await operatorCreatesAcme();
    const owner = t.session();
    const accept = await owner.api.invitations[":id"].accept.$post({
      param: { id: t.inviteIdFor(OWNER) },
      json: { name: "Olive Owner", password: OWNER_PASSWORD },
    });
    expect(accept.status).toBe(200);

    await owner.signIn(OWNER, OWNER_PASSWORD);
    await owner.enrollTotp(OWNER_PASSWORD);
    const me = await owner.api.me.$get();
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body).toMatchObject({
      user: { email: OWNER, name: "Olive Owner" },
      isOperator: false,
      organization: { name: "Acme Security", role: "owner" },
    });
  });

  test("the Operator console shows the Owner as invited, then active once they accept", async () => {
    const { t, operator } = await operatorCreatesAcme();
    const before = await (await operator.api.operator.organizations.$get()).json();
    expect(before.organizations).toMatchObject([
      { name: "Acme Security", members: 0, owner: { email: OWNER, status: "invited" } },
    ]);

    await t.session().api.invitations[":id"].accept.$post({
      param: { id: t.inviteIdFor(OWNER) },
      json: { name: "Olive Owner", password: OWNER_PASSWORD },
    });
    const after = await (await operator.api.operator.organizations.$get()).json();
    expect(after.organizations).toMatchObject([
      { name: "Acme Security", members: 1, owner: { email: OWNER, status: "active" } },
    ]);
  });

  test("the Operator console lists each Organization, newest first, with its own Owner and Member count", async () => {
    const { t, operator } = await operatorCreatesAcme();
    await t.session().api.invitations[":id"].accept.$post({
      param: { id: t.inviteIdFor(OWNER) },
      json: { name: "Olive Owner", password: OWNER_PASSWORD },
    });
    t.clock.advance(60_000);
    const res = await operator.api.operator.organizations.$post({
      json: { name: "Globex Defense", ownerEmail: "owner@globex.example" },
    });
    expect(res.status).toBe(201);

    const { organizations } = await (await operator.api.operator.organizations.$get()).json();
    expect(organizations).toMatchObject([
      { name: "Globex Defense", members: 0, owner: { email: "owner@globex.example", status: "invited" } },
      { name: "Acme Security", members: 1, owner: { email: OWNER, status: "active" } },
    ]);
  });

  test("an invitation can be accepted only once", async () => {
    const { t } = await operatorCreatesAcme();
    const id = t.inviteIdFor(OWNER);
    const accept = () =>
      t.session().api.invitations[":id"].accept.$post({
        param: { id },
        json: { name: "Olive Owner", password: OWNER_PASSWORD },
      });
    expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBe(404);
  });

  test("an invitation expires after 7 days", async () => {
    const { t } = await operatorCreatesAcme();
    t.clock.advance(7 * 24 * 60 * 60 * 1000 + 1);
    const res = await t.session().api.invitations[":id"].accept.$post({
      param: { id: t.inviteIdFor(OWNER) },
      json: { name: "Olive Owner", password: OWNER_PASSWORD },
    });
    expect(res.status).toBe(410);
  });

  test("an unknown invitation is not found", async () => {
    const t = await buildTestApp();
    const res = await t.session().api.invitations[":id"].$get({ param: { id: "nope" } });
    expect(res.status).toBe(404);
  });
});

describe("Operators are not Members", () => {
  test("creating an Organization does not make the Operator a Member of it", async () => {
    const { operator } = await operatorCreatesAcme();
    const me = await (await operator.api.me.$get()).json();
    expect(me).toMatchObject({ isOperator: true, organization: null });
    const orgs = await operator.auth.organization.list();
    expect(orgs.data).toEqual([]);
  });

  test("an Operator cannot switch into an Organization", async () => {
    const { t, operator } = await operatorCreatesAcme();
    const [org] = (await (await operator.api.operator.organizations.$get()).json()).organizations;
    const res = await operator.auth.organization.setActive({ organizationId: org!.id });
    expect(res.error?.status).toBe(403);
    expect(t.outbox.messages).toHaveLength(1);
  });
});

describe("Only Operators create Organizations", () => {
  test("anonymous requests are refused", async () => {
    const t = await buildTestApp();
    const res = await t.session().api.operator.organizations.$post({
      json: { name: "Rogue", ownerEmail: "x@rogue.example" },
    });
    expect(res.status as number).toBe(401);
  });

  test("an Owner cannot create Organizations", async () => {
    const { t } = await operatorCreatesAcme();
    const owner = await t.acceptInvite(OWNER, OWNER_PASSWORD);
    const viaApi = await owner.api.operator.organizations.$post({
      json: { name: "Second", ownerEmail: "x@second.example" },
    });
    expect(viaApi.status as number).toBe(403);
    const viaAuth = await owner.auth.organization.create({ name: "Second", slug: "second" });
    expect(viaAuth.error).toBeTruthy();
  });

  test("there is no self-serve sign-up", async () => {
    const t = await buildTestApp();
    const res = await t.session().auth.signUp.email({
      email: "self@serve.example",
      password: "self-serve-password",
      name: "Self Serve",
    });
    expect(res.error).toBeTruthy();
  });
});
