import { describe, expect, test } from "bun:test";
import { covers, DestinationListNotFound, UmbrellaRefused } from "./umbrella";
import { umbrellaHttpClient } from "./umbrella-http";

/** An Umbrella API that answers from `routes` (by method and path, query left out), recording each request. */
function stubUmbrella(routes: Record<string, (req: { url: URL; body: string }) => Response>) {
  const requests: { method: string; url: URL; authorization: string | null; body: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const url = new URL(req.url);
    const body = await req.text();
    requests.push({ method: req.method, url, authorization: req.headers.get("authorization"), body });
    const handler = routes[`${req.method} ${url.pathname}`];
    return handler ? handler({ url, body }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const token = () => Response.json({ access_token: "access", token_type: "bearer", expires_in: 3600 });
const credentials = { clientId: "key", clientSecret: "secret" };
const LISTS = "/policies/v2/destinationlists";
const list = (id: number) => ({ id, name: `List ${id}`, access: id % 2 ? "block" : "allow", isGlobal: id === 1, meta: { destinationCount: id } });

describe("The Umbrella API client", () => {
  test("signs in with the key and secret as client credentials, and a refusal is UmbrellaRefused", async () => {
    const ok = stubUmbrella({ "POST /auth/v2/token": token });
    await umbrellaHttpClient(credentials, ok.fetchImpl).check();
    expect(ok.requests[0]!.authorization).toBe(`Basic ${btoa("key:secret")}`);
    expect(ok.requests[0]!.body).toBe("grant_type=client_credentials");

    const refused = stubUmbrella({ "POST /auth/v2/token": () => Response.json({ error: "invalid_client" }, { status: 401 }) });
    const check = umbrellaHttpClient(credentials, refused.fetchImpl).check();
    await expect(check).rejects.toBeInstanceOf(UmbrellaRefused);
    await expect(check).rejects.toThrow("Signing in to the Umbrella API failed: 401 invalid_client");
  });

  test("lists destination lists across pages", async () => {
    const { requests, fetchImpl } = stubUmbrella({
      "POST /auth/v2/token": token,
      [`GET ${LISTS}`]: ({ url }) =>
        Response.json(
          url.searchParams.get("page") === "1"
            ? { meta: { page: 1, limit: 100, total: 101 }, data: Array.from({ length: 100 }, (_, i) => list(i + 1)) }
            : { meta: { page: 2, limit: 100, total: 101 }, data: [list(101)] },
        ),
    });
    const lists = await umbrellaHttpClient(credentials, fetchImpl).destinationLists();
    expect(lists).toHaveLength(101);
    expect(lists[0]).toEqual({ id: 1, name: "List 1", access: "block", isGlobal: true, destinationCount: 1 });
    expect(requests[1]!.authorization).toBe("Bearer access");
    expect(requests.map((r) => r.url.searchParams.get("page"))).toEqual([null, "1", "2"]);
  });

  test("adds a domain with a short comment, and reads the list back for its id", async () => {
    const { requests, fetchImpl } = stubUmbrella({
      "POST /auth/v2/token": token,
      [`POST ${LISTS}/7/destinations`]: () => Response.json({ status: { code: 200 }, data: { id: 7, name: "Phishing" } }),
      [`GET ${LISTS}/7/destinations`]: () =>
        Response.json({ meta: { total: 2 }, data: [{ id: "11", destination: "other.example", type: "domain" }, { id: "12", destination: "Evil.example", type: "domain" }] }),
    });
    const id = await umbrellaHttpClient(credentials, fetchImpl).addDestination(7, { destination: "evil.example", comment: "x".repeat(300) });
    expect(id).toBe("12");
    expect(JSON.parse(requests[1]!.body)).toEqual([{ destination: "evil.example", comment: "x".repeat(255) }]);
  });

  test("removing one the list no longer holds, or from a list that's gone, is already gone", async () => {
    const held = [{ id: "12", destination: "evil.example", type: "domain" }];
    const { requests, fetchImpl } = stubUmbrella({
      "POST /auth/v2/token": token,
      [`GET ${LISTS}/7/destinations`]: () => Response.json({ meta: { total: held.length }, data: held }),
      [`DELETE ${LISTS}/7/destinations/remove`]: () => Response.json({ status: { code: 200 }, data: { id: 7 } }),
    });
    const client = umbrellaHttpClient(credentials, fetchImpl);
    expect(await client.removeDestination(7, "12")).toBe(true);
    expect(JSON.parse(requests.at(-1)!.body)).toEqual([12]);
    expect(await client.removeDestination(7, "13")).toBe(false);
    expect(await client.removeDestination(8, "12")).toBe(false);
    await expect(client.destinations(8)).rejects.toBeInstanceOf(DestinationListNotFound);
  });

  test("a domain destination covers itself and the names under it; URLs and IPs cover nothing", () => {
    expect(covers({ destination: "evil.example", type: "domain" }, "evil.example")).toBe("exact");
    expect(covers({ destination: "*.Evil.example.", type: "domain" }, "a.b.evil.example")).toBe("parent");
    expect(covers({ destination: "evil.example", type: "domain" }, "notevil.example")).toBeNull();
    expect(covers({ destination: "https://evil.example/", type: "url" }, "evil.example")).toBeNull();
    expect(covers({ destination: "203.0.113.5", type: "ipv4" }, "203.0.113.5")).toBeNull();
  });
});
