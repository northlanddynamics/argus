import { describe, expect, test } from "bun:test";
import { MimecastRefused } from "./mimecast";
import { mimecastHttpClient } from "./mimecast-http";

/** A Mimecast API that answers from `routes`, recording each request with its body. */
function stubMimecast(routes: Record<string, (body: string) => Response>) {
  const requests: { path: string; authorization: string | null; body: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const url = new URL(req.url);
    const body = await req.text();
    requests.push({ path: `${url.origin}${url.pathname}`, authorization: req.headers.get("authorization"), body });
    const handler = routes[`${req.method} ${url.origin}${url.pathname}`];
    return handler ? handler(body) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const BASE = "https://api.services.mimecast.com";
const token = () => Response.json({ access_token: "access", expires_in: 1799 });
const credentials = { clientId: "id", clientSecret: "secret" };

describe("The Mimecast API client", () => {
  test("signs in with client credentials, and a refusal is MimecastRefused", async () => {
    const ok = stubMimecast({ [`POST ${BASE}/oauth/token`]: token });
    await mimecastHttpClient(credentials, ok.fetchImpl).check();
    expect(Object.fromEntries(new URLSearchParams(ok.requests[0]!.body))).toEqual({ client_id: "id", client_secret: "secret", grant_type: "client_credentials" });

    const refused = stubMimecast({ [`POST ${BASE}/oauth/token`]: () => Response.json({ error_description: "Bad credentials" }, { status: 401 }) });
    const check = mimecastHttpClient(credentials, refused.fetchImpl).check();
    await expect(check).rejects.toBeInstanceOf(MimecastRefused);
    await expect(check).rejects.toThrow("Signing in to the Mimecast API failed: 401 Bad credentials");
  });

  test("blocks a domain for everyone and returns the policy's id", async () => {
    const { requests, fetchImpl } = stubMimecast({
      [`POST ${BASE}/oauth/token`]: token,
      [`POST ${BASE}/api/policy/blockedsenders/create-policy`]: () => Response.json({ meta: { status: 200 }, data: [{ id: "pol-1" }], fail: [] }),
    });
    const id = await mimecastHttpClient(credentials, fetchImpl).blockSender({ type: "domain", value: "evil.example", appliesTo: "everyone", description: "C-1: Phish" });
    expect(id).toBe("pol-1");
    expect(requests[1]!.authorization).toBe("Bearer access");
    expect(JSON.parse(requests[1]!.body)).toEqual({
      data: [
        {
          option: "block_sender",
          policy: { description: "C-1: Phish", fromPart: "both", from: { type: "email_domain", emailDomain: "evil.example" }, to: { type: "everyone" } },
        },
      ],
    });
  });

  test("finds an entry across pages, ignoring ones that aren't for everyone", async () => {
    const pages = [
      { meta: { pagination: { next: "p2" } }, data: [{ id: "x", policy: { from: { type: "individual_email_address", emailAddress: "CEO@Evil.example" }, to: { type: "profile_group" } } }] },
      { meta: {}, data: [{ id: "y", policy: { description: "mail team", from: { type: "individual_email_address", emailAddress: "CEO@Evil.example" }, to: { type: "everyone" } } }] },
    ];
    const { requests, fetchImpl } = stubMimecast({
      [`POST ${BASE}/oauth/token`]: token,
      [`POST ${BASE}/api/policy/blockedsenders/get-policy`]: () => Response.json(pages.shift()),
    });
    expect(await mimecastHttpClient(credentials, fetchImpl).findBlockedSender("email", "ceo@evil.example")).toEqual({
      id: "y",
      type: "email",
      value: "ceo@evil.example",
      appliesTo: "everyone",
      description: "mail team",
    });
    expect(JSON.parse(requests[2]!.body).meta.pagination.pageToken).toBe("p2");
  });

  test("deleting one Mimecast no longer holds is already gone; other failures reject", async () => {
    const answers = [
      Response.json({ meta: { status: 200 }, data: [], fail: [{ errors: [{ code: "err_policy_not_found", message: "Policy not found" }] }] }),
      Response.json({ meta: { status: 200 }, data: [], fail: [{ errors: [{ code: "err_validation", message: "Permission denied" }] }] }),
      Response.json({ meta: { status: 200 }, data: [{ id: "pol-1" }], fail: [] }),
    ];
    const { fetchImpl } = stubMimecast({
      [`POST ${BASE}/oauth/token`]: token,
      [`POST ${BASE}/api/policy/blockedsenders/delete-policy`]: () => answers.shift()!,
    });
    const client = mimecastHttpClient(credentials, fetchImpl);
    expect(await client.deleteBlockedSender("pol-1")).toBe(false);
    await expect(client.deleteBlockedSender("pol-1")).rejects.toThrow("Removing a blocked sender from Mimecast failed: Permission denied");
    expect(await client.deleteBlockedSender("pol-1")).toBe(true);
  });
});
