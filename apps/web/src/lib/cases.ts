import { queryOptions } from "@tanstack/react-query";
import type { CaseSummary } from "api/cases/case-summary";
import { api } from "@/lib/api";

export {
  CASE_AUDIT_ACTIONS,
  CASE_TYPES,
  caseRef,
  caseTypeLabel,
  REOPENED_STATUS,
  RESOLUTIONS,
  resolutionLabel,
  SEVERITIES,
  severityLabel,
  STATUSES,
  statusLabel,
  type CaseAuditAction,
  type CaseType,
  type Resolution,
  type Severity,
  type Status,
} from "api/cases/vocabulary";
export type { CaseSummary };

export const casesKey = ["cases"] as const;
export const caseKey = (number: number) => ["cases", number] as const;

export const caseQuery = (number: number) =>
  queryOptions({
    queryKey: caseKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Case");
      return (await res.json()).case;
    },
  });

export type CaseView = NonNullable<Awaited<ReturnType<ReturnType<typeof caseQuery>["queryFn"] & {}>>>;

export const emptySummary = (): CaseSummary => ({ type: "doc", content: [] });

/** The Case Summary's words without formatting, one block per line. */
export function summaryText(doc: CaseSummary): string {
  type Node = { type: string; text?: string; content?: Node[] };
  const walk = (node: Node): string =>
    node.type === "text" ? (node.text ?? "") : node.type === "hardBreak" ? " " : (node.content ?? []).map(walk).join("");
  const blocks = (nodes: Node[]): string[] =>
    nodes.flatMap((n) => (n.type === "bulletList" || n.type === "listItem" ? blocks(n.content ?? []) : [walk(n)]));
  return blocks(doc.content as Node[]).join("\n");
}
