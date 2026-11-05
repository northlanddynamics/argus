import type { CaseSummary } from "../cases/case-summary";
import { caseRef, caseTypeLabel, resolutionLabel, severityLabel, statusLabel } from "../cases/vocabulary";
import { assetTypeLabel, defang, observableTypeLabel } from "../observables/vocabulary";
import { falconIocActionLabel, responseActionKindLabel, responseActionStateLabel } from "../response-actions/vocabulary";
import { describeOccurredAt, utc } from "../timeline/occurred-at";
import type { CaseReport } from "./case-reports";
import { reportVariantLabel } from "./vocabulary";

/**
 * A Case Report laid out once, as the blocks both renderers (`markdown.ts`, `pdf.ts`) draw: what it
 * says and in which order, without how it looks.
 */

/** A stretch of text in one style; `href` makes it a link. */
export type Run = { text: string; bold?: boolean; italic?: boolean; mono?: boolean; href?: string };

/** One entry in a section: a title line, detail lines under it, and an optional body of text. */
export type Item = { title: Run[]; details: Run[][]; body?: string };

export type Block =
  | { kind: "title"; text: string; subtitle: string }
  | { kind: "fields"; fields: [label: string, value: string][] }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; runs: Run[] }
  /** A bullet, `depth` levels deep (0 is outermost). */
  | { kind: "bullet"; depth: number; runs: Run[] }
  /** Something said about a section, such as that it is empty. */
  | { kind: "note"; text: string }
  | { kind: "item"; item: Item };

const text = (t: string): Run => ({ text: t });
const label = (t: string): Run => ({ text: t, bold: true });
const mono = (t: string): Run => ({ text: t, mono: true });

/** "1.2 MB (1,234,567 bytes)". */
export function sizeLabel(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const exact = `${bytes.toLocaleString("en-US")} bytes`;
  return unit === 0 ? exact : `${value.toFixed(1)} ${units[unit]} (${exact})`;
}

/** The Case Summary's ProseMirror document as blocks. */
function summaryBlocks(doc: CaseSummary): Block[] {
  type Inline = NonNullable<Extract<CaseSummary["content"][number], { type: "paragraph" }>["content"]>[number];
  const runs = (content: readonly Inline[] | undefined): Run[] =>
    (content ?? []).map((node) => {
      if (node.type === "hardBreak") return text("\n");
      const marks = node.marks ?? [];
      const link = marks.find((m) => m.type === "link");
      return {
        text: node.text,
        bold: marks.some((m) => m.type === "bold") || undefined,
        italic: marks.some((m) => m.type === "italic") || undefined,
        href: link?.type === "link" ? link.attrs.href : undefined,
      };
    });
  type List = Extract<CaseSummary["content"][number], { type: "bulletList" }>;
  const list = (node: List, depth: number): Block[] =>
    node.content.flatMap((li) =>
      li.content.flatMap((child, i): Block[] => {
        if (child.type === "bulletList") return list(child, depth + 1);
        // A list item's first paragraph carries the bullet; later ones continue it, one level in.
        return [{ kind: "bullet", depth: i === 0 ? depth : depth + 1, runs: runs(child.content) }];
      }),
    );
  return doc.content.flatMap((node): Block[] => {
    switch (node.type) {
      case "paragraph":
        return node.content?.length ? [{ kind: "paragraph", runs: runs(node.content) }] : [];
      case "heading":
        return [{ kind: "heading", level: 3, text: runs(node.content).map((r) => r.text).join("") }];
      case "bulletList":
        return list(node, 0);
    }
  });
}

/** "Ana Analyst, 2026-10-28 09:14 UTC". */
const byAt = (by: { name: string }, at: string) => `${by.name}, ${utc(at)}`;

/** The section's heading, then its items, or a note that it has none. */
const section = (heading: string, items: Item[], none: string): Block[] => [
  { kind: "heading", level: 2, text: heading },
  ...(items.length ? items.map((item): Block => ({ kind: "item", item })) : [{ kind: "note", text: none } as const]),
];

/** Every block of the report, in order. */
export function outline(report: CaseReport): Block[] {
  const c = report.case;
  const complete = report.variant === "complete";
  /** In the complete report, Internal items say so; the Guest-safe one has none. */
  const internal = (item: { internal: boolean }): Run[] => (complete && item.internal ? [label("Internal")] : []);
  const withInternal = (item: { internal: boolean }, details: Run[][]) => {
    const marker = internal(item);
    return marker.length ? [marker, ...details] : details;
  };

  const fields: [string, string][] = [
    ["Organization", report.organizationName],
    ["Status", statusLabel[c.status]],
    ["Severity", severityLabel[c.severity]],
    ["Case Type", caseTypeLabel[c.caseType]],
    ...(c.resolution ? [["Resolution", resolutionLabel[c.resolution]] as [string, string]] : []),
    ["Assignee", c.assignee?.name ?? "Unassigned"],
    ["Opened", byAt(c.openedBy, c.openedAt)],
    ...(c.closed ? [["Closed", byAt(c.closed.by, c.closed.at)] as [string, string]] : []),
    ...(c.tags.length ? [["Tags", c.tags.map((t) => `#${t}`).join(" ")] as [string, string]] : []),
    ["Generated", byAt({ name: report.generatedBy }, report.generatedAt)],
  ];

  const summary = summaryBlocks(c.summary.content);

  const timeline = report.timeline.map(
    (e): Item => ({
      title: [label(describeOccurredAt(e.occurredAt)), ...(e.retracted ? [text(" (retracted)")] : [])],
      details: withInternal(e, [
        ...(e.citations.length ? [[label("Cites: "), text(e.citations.map((x) => x.label).join("; "))]] : []),
        ...(e.source?.kind === "discussion_message"
          ? [[label("Promoted from: "), text(`Discussion message by ${byAt(e.source.author, e.source.postedAt)}`)]]
          : e.source?.kind === "audit_log_entry"
            ? [[label("Promoted from: "), text(`Audit Log entry by ${byAt({ name: e.source.actor }, e.source.occurredAt)}`)]]
            : []),
        [label("Recorded by: "), text(byAt(e.recordedBy, e.recordedAt))],
        ...(e.retracted
          ? [[label("Retracted by: "), text(byAt(e.retracted.by, e.retracted.at) + (e.retracted.reason ? `: ${e.retracted.reason}` : ""))]]
          : []),
      ]),
      body: e.body,
    }),
  );

  const tasks = report.tasks.map(
    (t): Item => ({
      title: [label(t.title), text(t.done ? " (done)" : t.overdue ? " (open, overdue)" : " (open)")],
      details: withInternal(t, [
        [label("Owner: "), text(t.owner.name)],
        ...(t.dueDate ? [[label("Due: "), text(t.dueDate)]] : []),
        ...(t.completed ? [[label("Completed by: "), text(byAt(t.completed.by, t.completed.at))]] : []),
      ]),
      body: t.description || undefined,
    }),
  );

  /** The details an Observable or Asset shares: who linked it and how, and the other Cases it is on. */
  const linked = (l: CaseReport["observables"][number] | CaseReport["assets"][number]): Run[][] => [
    [label("Added by: "), text(l.fromAlert ? `${byAt(l.linkedBy, l.linkedAt)}, from an Alert` : byAt(l.linkedBy, l.linkedAt))],
    ...(l.fromAlert?.alert ? [[label("Alert: "), text(`${l.fromAlert.alert.title} (${l.fromAlert.alert.externalId})`)]] : []),
    ...(l.seenIn.length ? [[label("Also on: "), text(l.seenIn.map((s) => `${caseRef(s.number)} ${s.title}`).join("; "))]] : []),
  ];
  const observables = report.observables.map(
    (o): Item => ({ title: [label(`${observableTypeLabel[o.type]}: `), mono(defang(o.type, o.value))], details: linked(o) }),
  );
  const assets = report.assets.map((a): Item => ({ title: [label(`${assetTypeLabel[a.type]}: `), mono(a.value)], details: linked(a) }));

  const evidence = report.evidence.map(
    (e): Item => ({
      title: [label(e.name)],
      details: withInternal(e, [
        [label("SHA-256: "), mono(e.sha256)],
        [label("Size: "), text(sizeLabel(e.size))],
        [label("Type: "), text(e.contentType)],
        [label("Added by: "), text(byAt(e.addedBy, e.addedAt))],
      ]),
    }),
  );

  // Says when Argus sent it, never that it is in force now.
  const responseActions = report.responseActions.map(
    (r): Item => ({
      title: [label(`${responseActionKindLabel[r.kind]}: `), mono(`${observableTypeLabel[r.observable.type]} ${defang(r.observable.type, r.observable.value)}`)],
      details: withInternal(r, [
        [label("State: "), text(responseActionStateLabel[r.state] + (r.sentAt ? `, sent ${utc(r.sentAt)}` : ""))],
        ...(r.origin === "already_present" && r.presentFrom
          ? [[label("Origin: "), text(`Already present (sent from ${r.presentFrom.case ? caseRef(r.presentFrom.case.number) : "another Case"} on ${utc(r.presentFrom.at)})`)]]
          : []),
        ...(r.origin === "in_tool" ? [[label("Origin: "), text("Already present in Falcon")]] : []),
        ...(r.dismissedBy && r.dismissedAt ? [[label("Dismissed by: "), text(byAt(r.dismissedBy, r.dismissedAt))]] : []),
        ...(r.falcon
          ? [[label("Action: "), text(`${falconIocActionLabel[r.falcon.action]}, severity ${severityLabel[r.falcon.severity]}`)]]
          : []),
        ...(r.integration ? [[label("Integration: "), text(r.integration.name)]] : []),
        [label("Taken by: "), text(byAt(r.requestedBy, r.requestedAt))],
        ...(r.state === "failed" && r.lastError ? [[label("Error: "), text(r.lastError)]] : []),
      ]),
    }),
  );

  return [
    {
      kind: "title",
      text: `${caseRef(c.number)}: ${c.title}`,
      subtitle: complete
        ? `${reportVariantLabel.complete} Case Report, including Internal items`
        : `${reportVariantLabel.guest_safe} Case Report, without Internal items`,
    },
    { kind: "fields", fields },
    { kind: "heading", level: 2, text: "Case Summary" },
    ...(summary.length
      ? [...summary, { kind: "note", text: `Last edited by ${byAt(c.summary.updatedBy, c.summary.updatedAt)}.` } as const]
      : [{ kind: "note", text: "No Case Summary yet." } as const]),
    ...section("Timeline", timeline, "No Timeline Entries."),
    ...section("Tasks", tasks, "No Tasks."),
    ...section("Observables", observables, "No Observables."),
    ...section("Assets", assets, "No Assets."),
    ...section("Response Actions", responseActions, "No Response Actions."),
    ...section("Evidence", evidence, "No Evidence."),
  ];
}
