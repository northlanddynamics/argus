import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const param = (number: number) => ({ number: String(number) });
const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** The Postgres error a query fails with (Drizzle wraps it as `cause`), or null if it succeeds. */
async function dbError(query: PromiseLike<unknown>) {
  try {
    await query;
    return null;
  } catch (e) {
    return String((e as { cause?: unknown }).cause ?? e);
  }
}

const PHISH = "From: billing@invoice-portal.biz\r\nSubject: Invoice 4471\r\n\r\nPlease pay.\r\n";

/** Acme Security: its Owner, Ana and Ben (Analysts), signed in, and a Case to work. */
async function acme(options: Parameters<typeof buildTestApp>[0] = {}) {
  const t = await buildTestApp(options);
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  const join = async (email: string, name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const ana = await join("ana@acme.example", "Ana Analyst");
  const ben = await join("ben@acme.example", "Ben Analyst");
  type Person = { api: typeof owner.api };

  const userId = async (as: Person) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };

  const open = async (as: Person = owner) => {
    const res = await as.api.cases.$post({ json: { title: "Invoice phish", caseType: "phishing", severity: "high" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };

  const evidence = (as: Person) => as.api.cases[":number"].evidence;

  /** Uploads `data` as the file `name`, the way the SPA does: the file is the request body. */
  const upload = async (
    as: Person,
    number: number,
    name: string,
    data: RequestInit["body"],
    headers: Record<string, string> = { "content-type": "message/rfc822" },
  ) => {
    const res = await evidence(as).$post({ param: param(number), query: { name } }, { init: { body: data, headers } });
    return { status: res.status, body: await res.json() };
  };
  /** Uploads a file that must be accepted, and returns it. */
  const add = async (as: Person, number: number, name = "invoice-4471.eml", data = PHISH) => {
    const res = await upload(as, number, name, data);
    if (res.status !== 201 || !("evidence" in res.body)) throw new Error(`Could not add Evidence: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.evidence;
  };
  const list = async (as: Person, number: number) => {
    const res = await evidence(as).$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };
  const view = (as: Person, number: number, id: string) => evidence(as)[":id"].view.$get({ param: { ...param(number), id } });
  const download = (as: Person, number: number, id: string) =>
    evidence(as)[":id"].download.$get({ param: { ...param(number), id } });

  const auditLog = async (as: Person, number: number) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };
  const evidenceAudit = async (as: Person, number: number) =>
    (await auditLog(as, number))
      .filter((e) => e.action.startsWith("evidence."))
      .map((e) => ({ action: e.action, actor: e.actor.name, target: e.target, after: e.after }))
      .toReversed();

  /** A Case only the Owner and Ana (its Assignee) can see. */
  const restrictedToAna = async () => {
    const number = await open();
    await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: await userId(ana), restricted: true } });
    return number;
  };

  return { t, owner, ana, ben, userId, open, upload, add, list, view, download, evidenceAudit, restrictedToAna };
}

describe("Adding Evidence", () => {
  test("anyone who can see the Case adds a file; it is fingerprinted with SHA-256 and listed oldest first", async () => {
    const { t, owner, ana, ben, userId, open, add, list } = await acme();
    const number = await open();
    const first = await add(ana, number);
    t.clock.advance(60_000);
    await add(ben, number, "netflow-0928.csv", "src,dst\n10.0.0.4,185.220.101.4\n");
    expect(first).toEqual({
      id: expect.any(String),
      name: "invoice-4471.eml",
      contentType: "message/rfc822",
      size: PHISH.length,
      sha256: sha256(PHISH),
      addedBy: { id: await userId(ana), name: "Ana Analyst" },
      addedAt: "2026-01-01T09:00:00.000Z",
      internal: false,
    });
    const { status, body } = await list(owner, number);
    expect(status).toBe(200);
    if (!("evidence" in body)) throw new Error("Could not list Evidence");
    expect(body.evidence.map((e) => [e.name, e.addedBy.name])).toEqual([
      ["invoice-4471.eml", "Ana Analyst"],
      ["netflow-0928.csv", "Ben Analyst"],
    ]);
  });

  test("the bytes are stored exactly as sent, and the fingerprint covers all of them", async () => {
    const { t, ana, open, upload } = await acme();
    const number = await open();
    const bytes = crypto.getRandomValues(new Uint8Array(200_000));
    const res = await upload(ana, number, "FIN-LT-0231.mem", new Blob([bytes]), { "content-type": "application/octet-stream" });
    expect(res.status).toBe(201);
    if (!("evidence" in res.body)) throw new Error("Could not add Evidence");
    expect(res.body.evidence).toMatchObject({ size: 200_000, sha256: sha256(bytes) });
    const [stored] = [...t.evidenceObjects.values()];
    expect(stored?.bytes).toEqual(bytes);
  });

  test("a file sent in pieces is fingerprinted as a whole", async () => {
    const { ana, open, upload } = await acme();
    const number = await open();
    const parts = ["From: a@b.example\r\n", "Subject: hi\r\n", "\r\nbody\r\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    const res = await upload(ana, number, "streamed.eml", stream);
    if (!("evidence" in res.body)) throw new Error("Could not add Evidence");
    expect(res.body.evidence.sha256).toBe(sha256(parts.join("")));
  });

  test("adding is recorded in the Audit Log with the fingerprint", async () => {
    const { ana, open, add, evidenceAudit } = await acme();
    const number = await open();
    await add(ana, number);
    expect(await evidenceAudit(ana, number)).toEqual([
      { action: "evidence.added", actor: "Ana Analyst", target: "invoice-4471.eml", after: `SHA-256 ${sha256(PHISH)}` },
    ]);
  });

  test("the content type is kept without parameters; a missing or malformed one is stored as octet-stream", async () => {
    const { ana, open, upload } = await acme();
    const number = await open();
    const typeOf = async (headers: Record<string, string>) => {
      const res = await upload(ana, number, "f.txt", "hello", headers);
      return "evidence" in res.body ? res.body.evidence.contentType : null;
    };
    expect(await typeOf({ "content-type": "Text/Plain; charset=utf-8" })).toBe("text/plain");
    expect(await typeOf({})).toBe("application/octet-stream");
    expect(await typeOf({ "content-type": "not a type" })).toBe("application/octet-stream");
  });

  test("two files with the same name are both kept", async () => {
    const { ana, open, add, list } = await acme();
    const number = await open();
    const a = await add(ana, number, "same.txt", "first");
    const b = await add(ana, number, "same.txt", "second");
    expect(a.id).not.toBe(b.id);
    const { body } = await list(ana, number);
    if (!("evidence" in body)) throw new Error("Could not list Evidence");
    expect(body.evidence.map((e) => e.sha256)).toEqual([sha256("first"), sha256("second")]);
  });

  test("an empty file, or a name with slashes or control characters, is refused and nothing is listed", async () => {
    const { ana, open, upload, list } = await acme();
    const number = await open();
    expect((await upload(ana, number, "empty.txt", "")).status).toBe(400);
    expect((await upload(ana, number, "empty.txt", null)).status).toBe(400);
    expect((await upload(ana, number, "../../etc/passwd", "x")).status).toBe(400);
    expect((await upload(ana, number, "a\\b.txt", "x")).status).toBe(400);
    expect((await upload(ana, number, "a\nb.txt", "x")).status).toBe(400);
    expect((await upload(ana, number, "   ", "x")).status).toBe(400);
    const { body } = await list(ana, number);
    expect(body).toEqual({ evidence: [] });
  });

  test("a file over the size limit is refused, whether or not it says how big it is", async () => {
    const { t, ana, open, upload, list } = await acme({ evidenceMaxBytes: 10 });
    const number = await open();
    const declared = await upload(ana, number, "big.bin", "x".repeat(11));
    expect(declared.status).toBe(413);
    expect(declared.body).toEqual({ error: "Evidence can be at most 10 bytes" });
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    expect((await upload(ana, number, "big.bin", streamed)).status).toBe(413);
    expect((await upload(ana, number, "ok.bin", "x".repeat(10))).status).toBe(201);
    const { body } = await list(ana, number);
    if (!("evidence" in body)) throw new Error("Could not list Evidence");
    expect(body.evidence.map((e) => e.name)).toEqual(["ok.bin"]);
    expect(t.evidenceObjects.size).toBe(1);
  });

  test("an upload from another site, or that names no site, is refused", async () => {
    const { t, ana, open, list } = await acme();
    const number = await open();
    const send = (headers: Record<string, string>) =>
      t.app.request(`http://argus.test/api/cases/${number}/evidence?name=x.txt`, {
        method: "POST",
        body: "x",
        headers: { cookie: ana.cookieHeader(), "content-type": "text/plain", ...headers },
      });
    expect((await send({ origin: "https://evil.example" })).status).toBe(403);
    expect((await send({})).status).toBe(403);
    expect((await send({ origin: "http://argus.test" })).status).toBe(201);
    const { body } = await list(ana, number);
    if (!("evidence" in body)) throw new Error("Could not list Evidence");
    expect(body.evidence).toHaveLength(1);
  });
});

describe("Evidence cannot be replaced or deleted", () => {
  test("there are no routes to replace or delete it, and the database refuses UPDATE, DELETE and TRUNCATE", async () => {
    const { t, ana, open, add, list } = await acme();
    const number = await open();
    const added = await add(ana, number);
    const route = ana.api.cases[":number"].evidence as unknown as Record<
      string,
      Record<string, (args: { param: Record<string, string> }) => Promise<Response>>
    >;
    const evidenceRoute = route[":id"]!;
    expect((await evidenceRoute.$delete!({ param: { ...param(number), id: added.id } })).status).toBe(404);
    expect((await evidenceRoute.$put!({ param: { ...param(number), id: added.id } })).status).toBe(404);
    expect((await evidenceRoute.$patch!({ param: { ...param(number), id: added.id } })).status).toBe(404);

    const { db } = t.deps;
    expect(await dbError(db.execute(sql`UPDATE evidence SET sha256 = repeat('0', 64)`))).toMatch(/cannot be altered or deleted/);
    expect(await dbError(db.execute(sql`UPDATE evidence SET name = 'other.eml'`))).toMatch(/cannot be altered or deleted/);
    expect(await dbError(db.execute(sql`DELETE FROM evidence`))).toMatch(/cannot be altered or deleted/);
    expect(await dbError(db.execute(sql`TRUNCATE evidence`))).toMatch(/cannot be altered or deleted/);
    const { body } = await list(ana, number);
    expect(body).toEqual({ evidence: [added] });
  });

  test("storage never writes over an object that is already there", async () => {
    const { t, ana, open, add } = await acme();
    const number = await open();
    await add(ana, number);
    const [key] = [...t.evidenceObjects.keys()];
    const replaced = t.deps.evidence.storage.put(key!, new Response("tampered").body!, "text/plain");
    await expect(replaced).rejects.toThrow(/already exists/);
    expect(new TextDecoder().decode(t.evidenceObjects.get(key!)!.bytes)).toBe(PHISH);
  });
});

describe("Viewing and downloading", () => {
  test("each view and download returns the file and is recorded in the Audit Log", async () => {
    const { ana, ben, open, add, view, download, evidenceAudit } = await acme();
    const number = await open();
    const added = await add(ana, number);

    const viewed = await view(ben, number, added.id);
    expect(viewed.status).toBe(200);
    expect(await viewed.text()).toBe(PHISH);
    const downloaded = await download(ana, number, added.id);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(PHISH);
    await download(ana, number, added.id);

    expect(await evidenceAudit(ana, number)).toEqual([
      { action: "evidence.added", actor: "Ana Analyst", target: "invoice-4471.eml", after: `SHA-256 ${sha256(PHISH)}` },
      { action: "evidence.viewed", actor: "Ben Analyst", target: "invoice-4471.eml", after: null },
      { action: "evidence.downloaded", actor: "Ana Analyst", target: "invoice-4471.eml", after: null },
      { action: "evidence.downloaded", actor: "Ana Analyst", target: "invoice-4471.eml", after: null },
    ]);
  });

  test("a download is an attachment under the file's own name, never cached", async () => {
    const { ana, open, add, download } = await acme();
    const number = await open();
    const added = await add(ana, number, "Rechnung März.pdf", "%PDF-1.4");
    const res = await download(ana, number, added.id);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe("8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Rechnung M_rz.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("viewing shows safe types as they are, and anything that could run as sandboxed plain text", async () => {
    const { ana, open, upload, view } = await acme();
    const number = await open();
    const viewedAs = async (name: string, type: string, data: string) => {
      const res = await upload(ana, number, name, data, { "content-type": type });
      if (!("evidence" in res.body)) throw new Error("Could not add Evidence");
      const viewed = await view(ana, number, res.body.evidence.id);
      return {
        type: viewed.headers.get("content-type"),
        disposition: viewed.headers.get("content-disposition")?.split(";")[0],
        csp: viewed.headers.get("content-security-policy"),
        nosniff: viewed.headers.get("x-content-type-options"),
      };
    };
    expect(await viewedAs("shot.png", "image/png", "png")).toEqual({ type: "image/png", disposition: "inline", csp: "sandbox", nosniff: "nosniff" });
    expect(await viewedAs("memo.pdf", "application/pdf", "%PDF")).toEqual({ type: "application/pdf", disposition: "inline", csp: null, nosniff: "nosniff" });
    for (const [name, type] of [
      ["login.html", "text/html"],
      ["logo.svg", "image/svg+xml"],
      ["dropper.js", "application/javascript"],
      ["page.xhtml", "application/xhtml+xml"],
      ["sample.exe", "application/octet-stream"],
    ] as const) {
      expect(await viewedAs(name, type, "<script>alert(1)</script>")).toEqual({
        type: "text/plain; charset=utf-8",
        disposition: "inline",
        csp: "sandbox",
        nosniff: "nosniff",
      });
    }
  });

  test("Evidence on another Case, or that doesn't exist, is not found and nothing is recorded", async () => {
    const { ana, open, add, view, download, evidenceAudit } = await acme();
    const number = await open();
    const other = await open();
    const added = await add(ana, other);
    expect((await view(ana, number, added.id)).status).toBe(404);
    expect((await download(ana, number, "missing")).status).toBe(404);
    expect(await evidenceAudit(ana, number)).toEqual([]);
  });

  test("a view or download announces the change to the Case, so its Audit Log stays live", async () => {
    const { t, ana, ben, open, add, view, download } = await acme();
    const number = await open();
    const added = await add(ana, number);
    const live = await t.connect(ben);
    await view(ana, number, added.id);
    expect(await live.next()).toEqual({ type: "case", number });
    await download(ana, number, added.id);
    expect(await live.next()).toEqual({ type: "case", number });
  });
});

describe("Only people who can see the Case reach its Evidence", () => {
  test("an Analyst not assigned to a Restricted Case gets not found everywhere, and nothing is stored or recorded", async () => {
    const { t, owner, ana, ben, add, upload, list, view, download, evidenceAudit, restrictedToAna } = await acme();
    const number = await restrictedToAna();
    const added = await add(ana, number);
    expect((await list(ben, number)).status).toBe(404);
    expect((await view(ben, number, added.id)).status).toBe(404);
    expect((await download(ben, number, added.id)).status).toBe(404);
    expect((await upload(ben, number, "x.txt", "x")).status).toBe(404);
    expect(t.evidenceObjects.size).toBe(1);
    expect((await download(owner, number, added.id)).status).toBe(200);
    expect((await evidenceAudit(owner, number)).map((e) => [e.action, e.actor])).toEqual([
      ["evidence.added", "Ana Analyst"],
      ["evidence.downloaded", "Olive Owner"],
    ]);
  });

  test("another Organization's Members get not found", async () => {
    const { t, ana, open, add, upload, list, view, download } = await acme();
    const number = await open();
    const added = await add(ana, number);
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    expect((await list(globex, number)).status).toBe(404);
    expect((await view(globex, number, added.id)).status).toBe(404);
    expect((await download(globex, number, added.id)).status).toBe(404);
    expect((await upload(globex, number, "x.txt", "x")).status).toBe(404);
  });

  test("signed out, nothing is reachable", async () => {
    const { t, ana, open, add } = await acme();
    const number = await open();
    const added = await add(ana, number);
    const anonymous = t.session();
    const evidence = anonymous.api.cases[":number"].evidence;
    expect((await evidence.$get({ param: param(number) })).status as number).toBe(401);
    expect((await evidence[":id"].download.$get({ param: { ...param(number), id: added.id } })).status as number).toBe(401);
  });
});

describe("A Closed Case's Evidence", () => {
  test("can't be added to until an Admin reopens it, but can still be viewed and downloaded, and that is recorded", async () => {
    const { owner, ana, open, add, upload, view, download, evidenceAudit } = await acme();
    const number = await open();
    const added = await add(ana, number);
    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } });
    const refused = await upload(ana, number, "late.txt", "late");
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "This Case is Closed and read-only; an Admin can reopen it" });
    expect((await view(ana, number, added.id)).status).toBe(200);
    expect((await download(ana, number, added.id)).status).toBe(200);
    expect((await evidenceAudit(ana, number)).map((e) => e.action)).toEqual([
      "evidence.added",
      "evidence.viewed",
      "evidence.downloaded",
    ]);
    await owner.api.cases[":number"].reopen.$post({ param: param(number) });
    expect((await upload(ana, number, "late.txt", "late")).status).toBe(201);
  });
});
