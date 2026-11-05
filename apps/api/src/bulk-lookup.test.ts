import { describe, expect, test } from "bun:test";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner, Ana (an Analyst, assigned to the Restricted Case) and Ben (an Analyst
 * who isn't), signed in; a CrowdStrike Integration delivering the EPP fixture detection.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  const join = async (email: string, name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const ana = await join("ana@acme.example", "Ana Analyst");
  const ben = await join("ben@acme.example", "Ben Analyst");
  type Session = ReturnType<typeof t.session>;
  const me = await (await ana.api.me.$get()).json();
  if (!("user" in me)) throw new Error("Not signed in");
  const anaId = me.user.id;

  const open = async (title: string, options: { restricted?: boolean } = {}) => {
    const body = await (await owner.api.cases.$post({ json: { title, caseType: "phishing", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    const number = body.case.number;
    if (options.restricted) await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: anaId, restricted: true } });
    return number;
  };
  const observe = async (number: number, type: "ip" | "domain" | "url" | "email", value: string) => {
    const res = await owner.api.cases[":number"].observables.$post({ param: param(number), json: { type, value } });
    if (res.status !== 201) throw new Error(`Could not link ${value}: ${res.status}`);
  };
  const detect = async () => {
    await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } });
    const falcon = fakeFalcon();
    const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
    t.onCleanup(worker.close);
    await worker.tick();
    const stream = falcon.tenant(CLIENT_ID);
    stream.emit("EppDetectionSummaryEvent", epp);
    await stream.drained();
  };
  const lookup = async (as: Session, text: string) => {
    const res = await as.api["bulk-lookup"].$post({ json: { text } });
    const body = await res.json();
    if (!("observables" in body)) throw new Error(`Bulk Lookup failed: ${res.status}`);
    return body.observables;
  };
  /** Just the values found, as `type value`. */
  const found = async (text: string, as: Session = ana) => (await lookup(as, text)).map((o) => `${o.type} ${o.value}`);
  const linked = async (number: number) => {
    const body = await (await owner.api.cases[":number"].observables.$get({ param: param(number) })).json();
    if (!("observables" in body)) throw new Error("No Observables");
    return body.observables;
  };
  const inviteGuest = async (number: number) => {
    const res = await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    if (res.status !== 201) throw new Error(`Could not invite the Guest: ${res.status}`);
    return t.guestSignIn(COUNSEL);
  };

  return { t, owner, ana, ben, open, observe, detect, lookup, found, linked, inviteGuest };
}

describe("Bulk Lookup", () => {
  test("finds every IP, domain, URL, email address and hash in the text once, normalised, defanged or not", async () => {
    const a = await acme();
    const text = [
      'From: "Payroll" <Payroll@Invoice-Portal.BIZ>',
      "Reset your password at hxxps://login.invoice-portal[.]biz/reset?id=7. Or at (https://invoice-portal.biz/help).",
      "C2 seen at 185.220.101[.]4 and 185.220.101.4, then 010.000.000.001 and 2001:0DB8:0000::0001.",
      "Payload 7353F60B1739074EB17C5F4DDDEFE239, dropper e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855,",
      "sha1 da39a3ee5e6b4b0d3255bfef95601890afd80709. Also invoice-portal[.]biz and payroll[@]invoice-portal(.)biz.",
    ].join("\n");
    expect(await a.found(text)).toEqual([
      "email payroll@invoice-portal.biz",
      "domain invoice-portal.biz",
      "url https://login.invoice-portal.biz/reset?id=7",
      "domain login.invoice-portal.biz",
      "url https://invoice-portal.biz/help",
      "ip 185.220.101.4",
      "ip 10.0.0.1",
      "ip 2001:db8::1",
      "md5 7353f60b1739074eb17c5f4dddefe239",
      "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "sha1 da39a3ee5e6b4b0d3255bfef95601890afd80709",
    ]);
    expect(await a.found("Nothing here, just words: 12:30:45, version 1.2.3.4.5, std::string, 999.1.1.1.")).toEqual([]);
  });

  test("counts a domain only when it ends in a public suffix, and never a file name", async () => {
    const a = await acme();
    const text = [
      "Attached report.pdf, invoice.docx, setup.sh, notes.zip, clip.mov and run.py.",
      "Words like e.g. config.internal, obj.method, Node.js and co.uk aren't domains; nor is admin@corp.local.",
      "But mail.example.co.uk, shop.bücher.de, www.ck and ana@corp.co.uk are.",
    ].join("\n");
    expect(await a.found(text)).toEqual([
      "domain mail.example.co.uk",
      "domain shop.xn--bcher-kva.de",
      "domain www.ck",
      "email ana@corp.co.uk",
      "domain corp.co.uk",
    ]);
  });

  test("marks what the Member can see on a Case or Alert as known, with those Cases and Alerts and its page", async () => {
    const a = await acme();
    const older = await a.open("Older phish");
    const phish = await a.open("Payroll phish");
    await a.observe(older, "domain", "invoice-portal.biz");
    await a.observe(phish, "domain", "invoice-portal.biz");
    await a.detect();

    const results = await a.lookup(a.ana, "invoice-portal[.]biz, 185.220.101.4 and unseen-domain.com");
    expect(results.map((r) => [r.value, !!r.known])).toEqual([
      ["invoice-portal.biz", true],
      ["185.220.101.4", true],
      ["unseen-domain.com", false],
    ]);
    const [domain, ip] = results;
    expect(domain!.known!.cases.map((c) => [c.number, c.title, c.status])).toEqual([
      [phish, "Payroll phish", "new"],
      [older, "Older phish", "new"],
    ]);
    // The fixture detection names the domain and the IP.
    expect(domain!.known!.alerts.map((x) => x.externalId)).toEqual([epp.CompositeId]);
    expect(ip!.known!.cases).toEqual([]);
    expect(ip!.known!.alerts).toEqual([expect.objectContaining({ externalId: epp.CompositeId, status: "new", case: null })]);

    const page = await (await a.ana.api.observables[":id"].$get({ param: { id: domain!.known!.id } })).json();
    expect("item" in page && page.item.value).toBe("invoice-portal.biz");
  });

  test("an Observable only on a Case the Member can't see is unknown to them, and that Case isn't shown", async () => {
    const a = await acme();
    const secret = await a.open("Insider", { restricted: true });
    const open = await a.open("Phish");
    await a.observe(secret, "domain", "insider-drop.com");
    await a.observe(secret, "domain", "shared-domain.com");
    await a.observe(open, "domain", "shared-domain.com");

    const asAna = await a.lookup(a.ana, "insider-drop.com shared-domain.com");
    expect(asAna.map((r) => r.known?.cases.map((c) => c.number))).toEqual([[secret], [open, secret]]);
    const asBen = await a.lookup(a.ben, "insider-drop.com shared-domain.com");
    expect(asBen.map((r) => r.known?.cases.map((c) => c.number) ?? null)).toEqual([null, [open]]);
  });

  test("links the chosen values to a Case the Member can work, as hand links, in one step", async () => {
    const a = await acme();
    const phish = await a.open("Payroll phish");
    await a.observe(phish, "domain", "invoice-portal.biz");

    const res = await a.ana.api["bulk-lookup"].link.$post({
      json: {
        case: phish,
        observables: [
          { type: "domain", value: "invoice-portal.biz" },
          { type: "ip", value: "185.220.101.4" },
          { type: "url", value: "https://login.invoice-portal.biz/reset?id=7" },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: 2, alreadyLinked: 1 });
    const now = await a.linked(phish);
    expect(now.map((o) => [o.type, o.value, o.linkedBy.name, o.fromAlert])).toEqual([
      ["domain", "invoice-portal.biz", "Olive Owner", null],
      ["ip", "185.220.101.4", "Ana Analyst", null],
      ["url", "https://login.invoice-portal.biz/reset?id=7", "Ana Analyst", null],
    ]);
    const known = await a.lookup(a.ana, "185.220.101.4");
    expect(known[0]!.known!.cases.map((c) => c.number)).toEqual([phish]);
  });

  test("links nothing when a value isn't valid, the Case is Closed or isn't one the Member can see", async () => {
    const a = await acme();
    const phish = await a.open("Payroll phish");
    const secret = await a.open("Insider", { restricted: true });
    const link = (number: number, values: { type: "ip" | "domain"; value: string }[]) =>
      a.ben.api["bulk-lookup"].link.$post({ json: { case: number, observables: values } });

    const invalid = await link(phish, [
      { type: "ip", value: "185.220.101.4" },
      { type: "ip", value: "not-an-ip" },
    ]);
    expect(invalid.status).toBe(400);
    expect(await a.linked(phish)).toEqual([]);

    expect((await link(secret, [{ type: "ip", value: "185.220.101.4" }])).status).toBe(404);
    expect(await a.linked(secret)).toEqual([]);

    await a.owner.api.cases[":number"].close.$post({ param: param(phish), json: { resolution: "true_positive" } });
    expect((await link(phish, [{ type: "ip", value: "185.220.101.4" }])).status).toBe(409);
  });

  test("refuses text over about 100 KB or holding more than 1,000 values, saying why", async () => {
    const a = await acme();
    const big = await a.ana.api["bulk-lookup"].$post({ json: { text: "word ".repeat(20_001) } });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "The text is over 100 KB. Split it and look up each part." });

    const ips = Array.from({ length: 1_001 }, (_, i) => `10.0.${i >> 8}.${i & 255}`).join("\n");
    const many = await a.ana.api["bulk-lookup"].$post({ json: { text: ips } });
    expect(many.status).toBe(413);
    expect(await many.json()).toEqual({
      error: "The text holds 1,001 values, more than the 1,000 Bulk Lookup takes at once. Split it and look up each part.",
    });

    expect(await a.found(ips.split("\n").slice(0, 1_000).join("\n"))).toHaveLength(1_000);
  });

  test("Guests can't use it", async () => {
    const a = await acme();
    const phish = await a.open("Payroll phish");
    await a.observe(phish, "domain", "invoice-portal.biz");
    const guest = await a.inviteGuest(phish);
    const refused = [
      guest.api["bulk-lookup"].$post({ json: { text: "invoice-portal.biz" } }),
      guest.api["bulk-lookup"].link.$post({ json: { case: phish, observables: [{ type: "ip", value: "185.220.101.4" }] } }),
    ];
    for (const res of refused) expect((await res).status).toBe(403);
    expect((await a.linked(phish)).map((o) => o.value)).toEqual(["invoice-portal.biz"]);
  });
});
