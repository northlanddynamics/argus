import { describe, expect, test } from "bun:test";
import { buildTestApp, totpSecret } from "./test/harness";

const OWNER = "owner@acme.example";
const PASSWORD = "correct-horse-battery";

/** An Organization whose Owner has accepted their invite but never signed in. */
async function acmeWithNewOwner() {
  const t = await buildTestApp();
  const operator = await t.createOperator();
  await operator.api.operator.organizations.$post({ json: { name: "Acme Security", ownerEmail: OWNER } });
  const accept = await t.session().api.invitations[":id"].accept.$post({
    param: { id: t.inviteIdFor(OWNER) },
    json: { name: "Olive Owner", password: PASSWORD },
  });
  expect(accept.status).toBe(200);
  return t;
}

/** An Organization whose Owner has enrolled in TOTP, then signed out. */
async function acmeWithEnrolledOwner() {
  const t = await acmeWithNewOwner();
  const first = t.session();
  await first.signIn(OWNER, PASSWORD);
  const totp = await first.enrollTotp(PASSWORD);
  await first.auth.signOut();
  return { t, totp };
}

describe("A Member without TOTP is forced through enrollment", () => {
  test("their password alone does not get them into Argus", async () => {
    const t = await acmeWithNewOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);

    const me = await owner.api.me.$get();
    expect(me.status as number).toBe(403);
    expect(await me.json()).toMatchObject({ code: "TOTP_ENROLLMENT_REQUIRED" });
  });

  test("Better Auth endpoints outside enrollment are refused too", async () => {
    const t = await acmeWithNewOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);

    const orgs = await owner.auth.organization.list();
    expect(orgs.error?.status).toBe(403);
    const passkeyOptions = await owner.auth.$fetch("/passkey/generate-register-options", { method: "GET" });
    expect(passkeyOptions.error?.status).toBe(403);
  });

  test("they enroll with a code from their authenticator app and are then signed in", async () => {
    const t = await acmeWithNewOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);

    const enabled = await owner.auth.twoFactor.enable({ password: PASSWORD });
    if (enabled.data?.method !== "totp") throw new Error("TOTP not enabled");
    expect(enabled.data.totpURI).toStartWith("otpauth://totp/Argus:");
    expect(enabled.data.backupCodes.length).toBeGreaterThan(0);
    expect((await owner.api.me.$get()).status as number).toBe(403);

    const code = await t.totpCode(totpSecret(enabled.data.totpURI));
    const verified = await owner.auth.twoFactor.verifyTotp({ code });
    expect(verified.error).toBeNull();

    const me = await owner.api.me.$get();
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ organization: { name: "Acme Security", role: "owner" } });
  });

  test("a wrong code does not complete enrollment", async () => {
    const t = await acmeWithNewOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);
    await owner.auth.twoFactor.enable({ password: PASSWORD });

    const verified = await owner.auth.twoFactor.verifyTotp({ code: "000000" });
    expect(verified.error?.status).toBe(401);
    expect((await owner.api.me.$get()).status as number).toBe(403);
  });

  test("enrollment needs their password again", async () => {
    const t = await acmeWithNewOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);

    const enabled = await owner.auth.twoFactor.enable({ password: "not-my-password-at-all" });
    expect(enabled.error?.status).toBe(400);
  });

  test("they can sign in again from the same browser before enrolling", async () => {
    const t = await acmeWithNewOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);
    await owner.signIn(OWNER, PASSWORD);
    await owner.enrollTotp(PASSWORD);
    expect((await owner.api.me.$get()).status).toBe(200);
  });

  test("an abandoned enrollment starts over at the next sign-in", async () => {
    const t = await acmeWithNewOwner();
    const first = t.session();
    await first.signIn(OWNER, PASSWORD);
    await first.auth.twoFactor.enable({ password: PASSWORD });

    const again = t.session();
    const result = await again.signIn(OWNER, PASSWORD);
    expect(result).not.toHaveProperty("twoFactorRedirect");
    await again.enrollTotp(PASSWORD);
    expect((await again.api.me.$get()).status).toBe(200);
  });
});

describe("Password sign-in cannot complete without TOTP", () => {
  test("after the password, there is no session until a TOTP code is given", async () => {
    const { t, totp } = await acmeWithEnrolledOwner();
    const owner = t.session();

    const result = await owner.signIn(OWNER, PASSWORD);
    expect(result).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect((await owner.api.me.$get()).status as number).toBe(401);

    const verified = await owner.auth.twoFactor.verifyTotp({ code: await t.totpCode(totp.secret) });
    expect(verified.error).toBeNull();
    expect((await owner.api.me.$get()).status).toBe(200);
  });

  test("a wrong code is refused", async () => {
    const { t } = await acmeWithEnrolledOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);

    const verified = await owner.auth.twoFactor.verifyTotp({ code: "000000" });
    expect(verified.error?.status).toBe(401);
    expect((await owner.api.me.$get()).status as number).toBe(401);
  });

  test("a TOTP code without the password first is refused", async () => {
    const { t, totp } = await acmeWithEnrolledOwner();
    const stranger = t.session();
    const verified = await stranger.auth.twoFactor.verifyTotp({ code: await t.totpCode(totp.secret) });
    expect(verified.error?.status).toBe(401);
  });

  test("a backup code stands in for a TOTP code, once", async () => {
    const { t, totp } = await acmeWithEnrolledOwner();
    const [backupCode] = totp.backupCodes;

    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);
    const verified = await owner.auth.twoFactor.verifyBackupCode({ code: backupCode! });
    expect(verified.error).toBeNull();
    expect((await owner.api.me.$get()).status).toBe(200);

    const again = t.session();
    await again.signIn(OWNER, PASSWORD);
    const reused = await again.auth.twoFactor.verifyBackupCode({ code: backupCode! });
    expect(reused.error).toBeTruthy();
  });

  test("a device cannot be trusted to skip TOTP next time", async () => {
    const { t, totp } = await acmeWithEnrolledOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);

    const verified = await owner.auth.twoFactor.verifyTotp({ code: await t.totpCode(totp.secret), trustDevice: true });
    expect(verified.error?.status).toBe(400);
  });

  test("a Member cannot turn TOTP off", async () => {
    const t = await acmeWithNewOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);
    await owner.enrollTotp(PASSWORD);

    const disabled = await owner.auth.twoFactor.disable({ password: PASSWORD });
    expect(disabled.error?.status).toBe(403);
    await owner.auth.signOut();
    expect(await t.session().signIn(OWNER, PASSWORD)).toMatchObject({ twoFactorRedirect: true });
  });
});

describe("Passkeys", () => {
  test("an enrolled Member can start registering a passkey", async () => {
    const t = await acmeWithNewOwner();
    const owner = t.session();
    await owner.signIn(OWNER, PASSWORD);
    await owner.enrollTotp(PASSWORD);

    const options = await owner.auth.$fetch<{ rp: { id: string; name: string } }>(
      "/passkey/generate-register-options",
      { method: "GET" },
    );
    expect(options.error).toBeNull();
    expect(options.data?.rp).toEqual({ id: "argus.test", name: "Argus" });
  });
});
