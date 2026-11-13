import { describe, expect, test } from "bun:test";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const TOKEN = "pk.eyJ1IjoiYWNtZSIsImEiOiJjbHgifQ.AbCdEfGhIjKlMn-a1b2";
const OTHER = "pk.eyJ1IjoiYWNtZSIsImEiOiJjbHkifQ.ZyXwVuTsRqPoNm_c3d4";

async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  const audit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "mapbox" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries.map((e) => [e.actor.name, e.action, e.before, e.after]);
  };
  return { owner, ana, audit };
}

describe("The Organization's Mapbox token", () => {
  test("an Admin sets, replaces and removes it, each recorded in the Organization Audit Log", async () => {
    const { owner, audit } = await acme();
    expect((await (await owner.api.mapbox.$get()).json()).mapbox.token).toBeNull();

    expect((await owner.api.mapbox.$put({ json: { token: TOKEN } })).status).toBe(200);
    const set = (await (await owner.api.mapbox.$get()).json()).mapbox;
    expect(set.token).toBe(TOKEN);
    expect(set.hint).toBe("pk.…a1b2");
    expect(set.updatedBy?.name).toBe("Olive Owner");

    expect((await owner.api.mapbox.$put({ json: { token: OTHER } })).status).toBe(200);
    expect((await owner.api.mapbox.$delete()).status).toBe(200);
    expect((await owner.api.mapbox.$delete()).status).toBe(404);

    expect(await audit()).toEqual([
      ["Olive Owner", "mapbox.token_removed", "pk.…c3d4", null],
      ["Olive Owner", "mapbox.token_changed", "pk.…a1b2", "pk.…c3d4"],
      ["Olive Owner", "mapbox.token_set", null, "pk.…a1b2"],
    ]);
  });

  test("every Member gets the token to draw maps with, but only Admins set it", async () => {
    const { owner, ana } = await acme();
    await owner.api.mapbox.$put({ json: { token: TOKEN } });
    const seen = (await (await ana.api.mapbox.$get()).json()).mapbox;
    expect(seen.token).toBe(TOKEN);
    expect(seen.updatedBy).toBeNull();
    expect((await ana.api.mapbox.$put({ json: { token: OTHER } })).status).toBe(403);
    expect((await ana.api.mapbox.$delete()).status).toBe(403);
  });

  test("only public tokens are taken: a secret token would reach every Member's browser", async () => {
    const { owner } = await acme();
    const secret = await owner.api.mapbox.$put({ json: { token: "sk.eyJ1IjoiYWNtZSJ9.secretpart" } });
    expect(secret.status).toBe(400);
    expect((await secret.json()) as unknown).toEqual({ error: expect.stringContaining("secret token") });
    expect((await owner.api.mapbox.$put({ json: { token: "not-a-token" } })).status).toBe(400);
    expect((await (await owner.api.mapbox.$get()).json()).mapbox.token).toBeNull();
  });
});
