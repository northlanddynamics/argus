import { describe, expect, test } from "bun:test";
import { fakeIdp } from "./test/fake-idp";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";

/** Acme Security: its Owner and Ana (an Analyst), signed in with passwords, and Acme's identity provider. */
async function acme({ sso = true, provisionAnalysts = false }: { sso?: boolean; provisionAnalysts?: boolean } = {}) {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  const idp = fakeIdp();
  type Session = typeof owner;

  const configure = (json: Partial<Parameters<Session["api"]["sso"]["$put"]>[0]["json"]> = {}, as: Session = owner) =>
    as.api.sso.$put({ json: { domain: "acme.example", idp: { metadataXml: idp.metadataXml }, provisionAnalysts, ...json } });
  if (sso) {
    const res = await configure();
    if (res.status !== 200) throw new Error(`Could not enable SSO: ${res.status} ${await res.text()}`);
  }
  const ssoAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "sso" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries.map((e) => [e.actor.name, e.action, e.before, e.after]);
  };
  const members = async () => {
    const body = await (await owner.api.organization.members.$get()).json();
    if (!("members" in body)) throw new Error("Could not list Members");
    return body.members;
  };
  /** A fresh browser signing in through Acme's identity provider. */
  const ssoSignIn = async (email: string, name?: string, typed?: string) => {
    const browser = t.session();
    const result = await idp.signIn(browser, { email, name }, typed);
    return { browser, ...result };
  };
  return { t, owner, ana, idp, configure, ssoAudit, members, ssoSignIn };
}

describe("Configuring SAML SSO", () => {
  test("an Admin enables, changes and disables it, each recorded in the Organization Audit Log", async () => {
    const { owner, idp, configure, ssoAudit } = await acme({ sso: false });
    const off = (await (await owner.api.sso.$get()).json()).sso;
    expect(off.enabled).toBe(false);
    expect(off.config).toBeNull();

    expect((await configure()).status).toBe(200);
    const on = (await (await owner.api.sso.$get()).json()).sso;
    expect(on.enabled).toBe(true);
    expect(on.config).toMatchObject({ domain: "acme.example", provisionAnalysts: false, idp: { entityId: idp.entityId }, updatedBy: { name: "Olive Owner" } });
    if (!("serviceProvider" in on)) throw new Error("Admins see the service provider");
    expect(on.serviceProvider.acsUrl).toStartWith("http://argus.test/api/auth/sso/saml2/sp/acs/");
    expect(on.serviceProvider.entityId).toStartWith("http://argus.test/api/auth/sso/saml2/sp/metadata?providerId=");

    // By hand: the IdP's entity ID, sign-in URL and signing certificate.
    const manual = { entityId: idp.entityId, ssoUrl: idp.ssoUrl, certificate: idp.certificate };
    expect((await configure({ idp: manual, provisionAnalysts: true })).status).toBe(200);
    // Without an identity provider, the configured one is kept.
    expect((await configure({ idp: undefined, provisionAnalysts: false })).status).toBe(200);
    expect((await owner.api.sso.$delete()).status).toBe(200);
    expect((await owner.api.sso.$delete()).status as number).toBe(404);

    const summary = `acme.example · ${idp.entityId}`;
    expect(await ssoAudit()).toEqual([
      ["Olive Owner", "sso.disabled", `${summary} · Members only`, null],
      ["Olive Owner", "sso.changed", `${summary} · provisions Analysts`, `${summary} · Members only`],
      ["Olive Owner", "sso.changed", `${summary} · Members only`, `${summary} · provisions Analysts`],
      ["Olive Owner", "sso.enabled", null, `${summary} · Members only`],
    ]);
  });

  test("Analysts see only whether it is on, and can't change it", async () => {
    const { ana, configure } = await acme();
    const seen = (await (await ana.api.sso.$get()).json()).sso;
    expect(seen).toEqual({ enabled: true, config: null });
    expect((await configure({}, ana)).status as number).toBe(403);
    expect((await ana.api.sso.$delete()).status as number).toBe(403);
  });

  test("unreadable metadata, a bad certificate or domain, and another Organization's domain are refused", async () => {
    const { t, idp, configure } = await acme({ sso: false });
    expect((await configure({ idp: { metadataXml: "<not-metadata/>" } })).status as number).toBe(400);
    expect((await configure({ idp: { entityId: idp.entityId, ssoUrl: idp.ssoUrl, certificate: "not a certificate" } })).status as number).toBe(400);
    expect((await configure({ idp: { entityId: idp.entityId, ssoUrl: "ftp://idp", certificate: idp.certificate } })).status as number).toBe(400);
    const lines = idp.certificate.trim().split("\n");
    const truncated = [...lines.slice(0, -3), ...lines.slice(-1)].join("\n");
    expect((await configure({ idp: { entityId: idp.entityId, ssoUrl: idp.ssoUrl, certificate: truncated } })).status as number).toBe(400);
    expect((await configure({ idp: undefined })).status as number).toBe(400);
    expect((await configure({ domain: "not a domain" })).status as number).toBe(400);
    expect((await configure()).status).toBe(200);

    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    const res = await globex.api.sso.$put({ json: { domain: "acme.example", idp: { metadataXml: idp.metadataXml }, provisionAnalysts: false } });
    expect(res.status as number).toBe(409);
  });

  test("the plugin's own endpoints for managing connections are closed", async () => {
    const { owner } = await acme();
    const register = await owner.auth.$fetch("/sso/register", {
      method: "POST",
      body: { providerId: "mine", issuer: "https://evil.example", domain: "evil.example" },
    });
    expect(register.error?.status).toBe(403);
    const providers = await owner.auth.$fetch("/sso/providers", { method: "GET" });
    expect(providers.error?.status).toBe(403);
  });
});

describe("Signing in with SSO", () => {
  test("a Member signs in through the identity provider, with no TOTP of their own", async () => {
    const { ssoSignIn, members } = await acme();
    const { browser, status, error, location } = await ssoSignIn("ana@acme.example");
    expect(status).toBe(302);
    expect(error).toBeNull();
    expect(location).toBe("/");

    const me = await browser.api.me.$get();
    expect(me.status).toBe(200);
    expect((await members()).find((m) => m.email === "ana@acme.example")?.signIn.sso).toBe(true);
  });

  test("a Member who signed in with a password but hasn't enrolled in TOTP can sign in with SSO instead", async () => {
    const { t, idp, owner } = await acme();
    await owner.api.organization.invitations.$post({ json: { email: "pat@acme.example", role: "analyst" } });
    const browser = t.session();
    await browser.api.invitations[":id"].accept.$post({ param: { id: t.inviteIdFor("pat@acme.example") }, json: { name: "Pat", password: PASSWORD } });
    await browser.signIn("pat@acme.example", PASSWORD);
    expect((await browser.api.me.$get()).status as number).toBe(403);

    expect((await idp.signIn(browser, { email: "pat@acme.example" })).error).toBeNull();
    expect((await browser.api.me.$get()).status).toBe(200);
  });

  test("a Member's name and email in Argus are kept, whatever the identity provider says", async () => {
    const { ssoSignIn, members } = await acme();
    await ssoSignIn("ANA@acme.example", "Anastasia From The IdP");
    expect((await members()).find((m) => m.email === "ana@acme.example")?.name).toBe("Ana Analyst");
  });

  test("someone who isn't a Member is refused unless the Organization provisions Analysts", async () => {
    const { t, ssoSignIn } = await acme();
    const { browser, error, location } = await ssoSignIn("newbie@acme.example");
    expect(error).toBe("not_a_member");
    expect(location).toStartWith("/sign-in?");
    expect((await browser.api.me.$get()).status as number).toBe(401);
    expect(await t.deps.db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, "newbie@acme.example") })).toBeUndefined();
  });

  test("with provisioning on, a new person from the Organization's domain joins as an Analyst", async () => {
    const { ssoSignIn, members, owner } = await acme({ provisionAnalysts: true });
    const { browser, error } = await ssoSignIn("newbie@acme.example", "Nia Newbie");
    expect(error).toBeNull();
    const me = await (await browser.api.me.$get()).json();
    expect(me).toMatchObject({ user: { name: "Nia Newbie", email: "newbie@acme.example" }, organization: { role: "analyst" } });
    expect((await members()).find((m) => m.email === "newbie@acme.example")).toMatchObject({ name: "Nia Newbie", role: "analyst" });

    const audit = await (await owner.api.organization["audit-log"].$get({ query: { category: "members" } })).json();
    if (!("entries" in audit)) throw new Error("No audit log");
    expect(audit.entries[0]).toMatchObject({ actor: { name: "Nia Newbie" }, action: "member.joined", target: "newbie@acme.example", after: "analyst" });

    // Signing in again finds the same Member.
    expect((await ssoSignIn("newbie@acme.example")).error).toBeNull();
    expect((await members()).filter((m) => m.email === "newbie@acme.example")).toHaveLength(1);
  });

  test("provisioning stops at the Organization's email domain", async () => {
    const { ssoSignIn, members } = await acme({ provisionAnalysts: true });
    // The identity provider vouches for an address outside acme.example.
    const { error } = await ssoSignIn("someone@elsewhere.example", "Someone", "someone@acme.example");
    expect(error).toBe("email_domain_mismatch");
    expect((await members()).map((m) => m.email)).not.toContain("someone@elsewhere.example");
  });

  test("someone with a pending invitation joins with the invited role, even without provisioning", async () => {
    const { owner, ssoSignIn, members } = await acme();
    await owner.api.organization.invitations.$post({ json: { email: "ada@acme.example", role: "admin" } });
    const { error } = await ssoSignIn("ada@acme.example", "Ada Admin");
    expect(error).toBeNull();
    expect((await members()).find((m) => m.email === "ada@acme.example")?.role).toBe("admin");
    const pending = await (await owner.api.organization.members.$get()).json();
    if (!("invitations" in pending)) throw new Error("No invitations");
    expect(pending.invitations).toEqual([]);
  });

  test("Members of other Organizations and Guests are refused", async () => {
    const { t, ssoSignIn } = await acme({ provisionAnalysts: true });
    await t.inviteOwner("Globex", "gil@acme.example");
    await t.acceptInvite("gil@acme.example", PASSWORD, "Gil Globex");
    expect((await ssoSignIn("gil@acme.example")).error).toBe("not_a_member");
  });

  test("a removed Member can no longer sign in with SSO", async () => {
    const { owner, ssoSignIn, members } = await acme({ provisionAnalysts: true });
    const { browser } = await ssoSignIn("ana@acme.example");
    const ana = (await members()).find((m) => m.email === "ana@acme.example")!;
    expect((await owner.api.organization.members[":id"].$delete({ param: { id: ana.id } })).status).toBe(200);
    expect((await browser.api.me.$get()).status as number).toBe(401);
    expect((await ssoSignIn("ana@acme.example")).error).toBe("not_a_member");
  });

  test("an email domain without SSO gets nowhere", async () => {
    const { t, idp } = await acme();
    const result = await idp.signIn(t.session(), { email: "x@globex.example" });
    expect(result).toMatchObject({ status: 404, error: "no_connection" });
  });

  test("a response no sign-in from Argus asked for is refused", async () => {
    const { t, idp } = await acme();
    const browser = t.session();
    const { providerId } = await idp.start(t.session(), "ana@acme.example");
    if (!providerId) throw new Error("SSO didn't start");
    const unsolicited = await idp.post(browser, providerId, await idp.respond(browser, providerId, { email: "ana@acme.example" }));
    expect(new URL(unsolicited.headers.get("location") ?? "", "http://argus.test").searchParams.get("error")).not.toBeNull();
    expect((await browser.api.me.$get()).status as number).toBe(401);
  });

  test("disabling SSO ends the sessions it started and stops its sign-ins; password sessions stay", async () => {
    const { owner, ana, ssoSignIn } = await acme();
    const { browser } = await ssoSignIn("ana@acme.example");
    expect((await browser.api.me.$get()).status).toBe(200);

    expect((await owner.api.sso.$delete()).status).toBe(200);
    expect((await browser.api.me.$get()).status as number).toBe(401);
    expect((await ana.api.me.$get()).status).toBe(200);
    expect((await owner.api.me.$get()).status).toBe(200);
    expect((await ssoSignIn("ana@acme.example")).error).toBe("no_connection");
  });
});
