import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { escapeMarkdown } from "./case-reports/markdown";
import type { ReportFormat, ReportVariant } from "./case-reports/vocabulary";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const COUNSEL = "k.patel@lawfirm.example";
const param = (number: number) => ({ number: String(number) });
const at = (iso: string) => ({ kind: "exact" as const, at: iso });
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/**
 * Acme Security: the Owner, Ana (an Analyst) and outside counsel (a Guest) on a Case that has a
 * Summary, Timeline Entries, Tasks, Observables, an Asset and Evidence, some of them Internal.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;
  const anaId = await (async () => {
    const me = await (await ana.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  })();

  const open = async (title: string) => {
    const body = await (await owner.api.cases.$post({ json: { title, caseType: "phishing", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    return body.case.number;
  };
  const number = await open("Invoice phishing → finance");
  const other = await open("Earlier invoice lure");

  const summary = {
    type: "doc" as const,
    content: [
      { type: "heading" as const, attrs: { level: 2 as const }, content: [{ type: "text" as const, text: "What we know" }] },
      {
        type: "paragraph" as const,
        content: [
          { type: "text" as const, text: "Three users clicked; " },
          { type: "text" as const, text: "credentials reset", marks: [{ type: "bold" as const }] },
          { type: "text" as const, text: " — see the " },
          { type: "text" as const, text: "vendor notice", marks: [{ type: "link" as const, attrs: { href: "https://vendor.example/notice" } }] },
        ],
      },
      {
        type: "bulletList" as const,
        content: [{ type: "listItem" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Mail purged" }] }] }],
      },
    ],
  };
  await owner.api.cases[":number"].summary.$put({ param: param(number), json: { summary, version: 1 } });

  const task = async (title: string, internal: boolean) => {
    const res = await owner.api.cases[":number"].tasks.$post({
      param: param(number),
      json: { title, description: `Notes for ${title}`, ownerId: anaId, internal },
    });
    return ((await res.json()) as { task: { id: string } }).task.id;
  };
  await task("Reset passwords", false);
  const secretTask = await task("Brief the CFO", true);

  const entry = async (body: string, internal: boolean, citations: { kind: "task"; id: string }[] = []) => {
    const res = await owner.api.cases[":number"].timeline.$post({
      param: param(number),
      json: { occurredAt: at("2026-10-28T09:14:00.000Z"), body, citations, internal },
    });
    if (res.status !== 201) throw new Error(`Could not add an entry: ${res.status}`);
  };
  await entry("Lure delivered to 40 mailboxes", false, [{ kind: "task", id: secretTask }]);
  await entry("CFO's assistant forwarded it", true);

  await owner.api.cases[":number"].observables.$post({ param: param(number), json: { type: "domain", value: "invoice-portal.biz" } });
  await owner.api.cases[":number"].observables.$post({ param: param(other), json: { type: "domain", value: "invoice-portal.biz" } });
  await owner.api.cases[":number"].assets.$post({ param: param(number), json: { type: "host", value: "FIN-LT-0231" } });

  const upload = (as: Session, name: string, internal: boolean) =>
    t.app.request(`http://argus.test/api/cases/${number}/evidence?name=${name}&internal=${internal}`, {
      method: "POST",
      headers: { cookie: as.cookieHeader(), origin: "http://argus.test", "content-type": "text/plain" },
      body: `Contents of ${name}`,
    });
  await upload(owner, "headers.eml", false);
  await upload(owner, "cfo-memo.txt", true);

  const invited = await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel" } });
  if (invited.status !== 201) throw new Error(`Could not invite counsel: ${invited.status}`);
  const guest = await t.guestSignIn(COUNSEL);

  const exportReport = (as: Session, variant: ReportVariant, format: ReportFormat, on = number) =>
    as.api.cases[":number"].report.$get({ param: param(on), query: { variant, format } });
  const markdown = async (as: Session, variant: ReportVariant) => {
    const res = await exportReport(as, variant, "markdown");
    expect(res.status).toBe(200);
    return res.text();
  };
  const auditLog = async () => {
    const body = await (await owner.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };
  return { t, owner, ana, guest, number, other, exportReport, markdown, auditLog };
}

describe("Case Reports", () => {
  test("the complete report holds the Summary, Timeline, Tasks, Observables, Assets and Evidence with fingerprints", async () => {
    const { owner, markdown } = await acme();
    const md = await markdown(owner, "complete");

    expect(md).toContain("# C-1: Invoice phishing → finance");
    expect(md).toContain("Complete Case Report, including Internal items");
    expect(md).toContain("### What we know");
    expect(md).toContain("**credentials reset**");
    expect(md).toContain("[vendor notice](<https://vendor.example/notice>)");
    expect(md).toContain("- Mail purged");
    expect(md).toContain("Lure delivered to 40 mailboxes");
    expect(md).toContain("**Cites:** Task: Brief the CFO");
    expect(md).toContain("CFO's assistant forwarded it");
    expect(md).toContain("**Reset passwords**");
    expect(md).toContain("**Brief the CFO**");
    expect(md).toContain("`invoice-portal[.]biz`");
    expect(md).toContain("**Also on:** C-2 Earlier invoice lure");
    expect(md).toContain("`FIN-LT-0231`");
    expect(md).toContain("**headers.eml**");
    expect(md).toContain(`\`${sha256("Contents of headers.eml")}\``);
    expect(md).toContain("**cfo-memo.txt**");
    expect(md).toContain(`\`${sha256("Contents of cfo-memo.txt")}\``);
    // Internal items say so.
    expect(md.match(/\*\*Internal\*\*/g)?.length).toBe(3);
  });

  test("the Guest-safe report leaves out every Internal item, and what Guests never see", async () => {
    const { owner, markdown } = await acme();
    const md = await markdown(owner, "guest_safe");

    expect(md).toContain("Guest-safe Case Report, without Internal items");
    expect(md).toContain("Lure delivered to 40 mailboxes");
    expect(md).toContain("Reset passwords");
    expect(md).toContain("headers.eml");
    expect(md).toContain(sha256("Contents of headers.eml"));
    expect(md).toContain("invoice-portal[.]biz");
    for (const hidden of ["Brief the CFO", "CFO's assistant", "cfo-memo.txt", sha256("Contents of cfo-memo.txt"), "Earlier invoice lure", "Internal**"]) {
      expect(md).not.toContain(hidden);
    }
  });

  test("Guests export the Guest-safe report, as it is for Members, and never the complete one", async () => {
    const { owner, guest, exportReport, markdown } = await acme();
    for (const format of ["markdown", "pdf"] as const) {
      const refused = await exportReport(guest, "complete", format);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "Guests can export only the Guest-safe Case Report" });
    }
    const theirs = await markdown(guest, "guest_safe");
    const members = await markdown(owner, "guest_safe");
    const generated = /^- \*\*Generated:\*\* .*$/m;
    expect(theirs.replace(generated, "")).toBe(members.replace(generated, ""));
    expect(theirs).toContain("**Generated:** Kim Patel");
  });

  test("PDF reports are A4 documents named after the Case and variant", async () => {
    const { owner, guest, exportReport } = await acme();
    for (const [as, variant, subject] of [
      [owner, "complete", "Complete Case Report"],
      [guest, "guest_safe", "Guest-safe Case Report"],
    ] as const) {
      const res = await exportReport(as, variant, "pdf");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="C-1-case-report-${variant === "complete" ? "complete" : "guest-safe"}.pdf"`,
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getTitle()).toBe("C-1: Invoice phishing → finance");
      expect(pdf.getSubject()).toBe(subject);
      expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
      const [width, height] = [pdf.getPage(0).getWidth(), pdf.getPage(0).getHeight()];
      expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
    }
  });

  test("Markdown reports download as .md files", async () => {
    const { owner, exportReport } = await acme();
    const res = await exportReport(owner, "complete", "markdown");
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="C-1-case-report-complete.md"');
  });

  test("every export is recorded in the Case Audit Log", async () => {
    const { owner, guest, exportReport, auditLog } = await acme();
    await exportReport(owner, "complete", "pdf");
    await exportReport(owner, "guest_safe", "markdown");
    await exportReport(guest, "guest_safe", "pdf");
    await exportReport(guest, "complete", "markdown");

    const exports = (await auditLog()).filter((e) => e.action === "case.report_exported");
    expect(exports.map((e) => ({ actor: e.actor.name, type: e.actor.type, target: e.target }))).toEqual([
      { actor: "Kim Patel", type: "guest", target: "Guest-safe Case Report (PDF)" },
      { actor: "Olive Owner", type: "member", target: "Guest-safe Case Report (Markdown)" },
      { actor: "Olive Owner", type: "member", target: "Complete Case Report (PDF)" },
    ]);
  });

  test("a Case the Member can't see has no report, and its export isn't recorded", async () => {
    const { owner, ana, number, exportReport, auditLog } = await acme();
    await owner.api.cases[":number"].$patch({ param: param(number), json: { restricted: true } });
    const res = await exportReport(ana, "complete", "markdown");
    expect(res.status).toBe(404);
    expect((await auditLog()).some((e) => e.action === "case.report_exported")).toBe(false);
  });

  test("Closed Cases export, with their Resolution", async () => {
    const { owner, number, markdown } = await acme();
    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } });
    const md = await markdown(owner, "complete");
    expect(md).toContain("**Status:** Closed");
    expect(md).toContain("**Resolution:** True Positive");
    expect(md).toContain("**Closed:** Olive Owner");
  });

  test("text from the Case can't add Markdown or HTML of its own", async () => {
    const { owner, exportReport } = await acme();
    const body = await (
      await owner.api.cases.$post({
        json: { title: "<img src=x onerror=alert(1)> [click](javascript:alert(1)) **bold**", caseType: "other", severity: "low" },
      })
    ).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    const md = await (await exportReport(owner, "complete", "markdown", body.case.number)).text();
    expect(md).toContain("\\<img src=x onerror=alert\\(1\\)\\> \\[click\\]\\(javascript:alert\\(1\\)\\) \\*\\*bold\\*\\*");
    expect(escapeMarkdown("- not a list\n1. nor this\n# nor a heading")).toBe("\\- not a list\n1\\. nor this\n\\# nor a heading");
  });
});
