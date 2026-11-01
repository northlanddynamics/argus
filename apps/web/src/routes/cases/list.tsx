import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import {
  CASE_TYPES,
  type CaseType,
  caseRef,
  caseTypeLabel,
  casesKey,
  SEVERITIES,
  type Severity,
  severityLabel,
  STATUSES,
  type Status,
  statusLabel,
} from "@/lib/cases";
import { normaliseTag, tagLabel, tagsInUseQuery } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { OpenCaseDialog } from "@/routes/cases/open-case-dialog";

export const CASE_VIEWS = ["mine", "unassigned", "open", "closed"] as const;
export type CaseListView = (typeof CASE_VIEWS)[number];
export type CaseListSearch = { view?: CaseListView; status?: Status; severity?: Severity; caseType?: CaseType; tag?: string };

const pick = <T extends string>(list: readonly T[], value: unknown) => (list.includes(value as T) ? (value as T) : undefined);

/** Reads the list's view and filters from the URL, ignoring anything unknown. */
export const validateCaseListSearch = (search: Record<string, unknown>): CaseListSearch => ({
  view: pick(CASE_VIEWS, search.view),
  status: pick(STATUSES, search.status),
  severity: pick(SEVERITIES, search.severity),
  caseType: pick(CASE_TYPES, search.caseType),
  tag: typeof search.tag === "string" ? (normaliseTag(search.tag) ?? undefined) : undefined,
});

const viewLabel: Record<CaseListView, string> = { mine: "My Cases", unassigned: "Unassigned", open: "All open", closed: "Closed" };

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

export function CasesPage() {
  const search = useSearch({ from: "/_app/" });
  const navigate = useNavigate({ from: "/" });
  const view = search.view ?? "mine";
  const setSearch = (next: Partial<CaseListSearch>) => navigate({ search: (prev) => ({ ...prev, ...next }) });

  const cases = useQuery({
    queryKey: [...casesKey, { ...search, view }],
    queryFn: async () => {
      const res = await api.cases.$get({ query: { ...search, view } });
      if (!res.ok) throw new Error("Could not load Cases");
      return res.json();
    },
  });
  const counts = cases.data?.counts;
  const tagsInUse = useQuery(tagsInUseQuery);
  const tagOptions = [...new Set([...(tagsInUse.data?.map((t) => t.tag) ?? []), ...(search.tag ? [search.tag] : [])])].toSorted();
  const tagLabels = Object.fromEntries(tagOptions.map((t) => [t, tagLabel(t)]));

  return (
    <div className="mx-auto grid w-full grid-cols-1 max-w-6xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cases</h1>
          <p className="text-sm text-muted-foreground">Every Case you can see, filtered by view, Status, Severity, Case Type and Tag.</p>
        </div>
        <OpenCaseDialog />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4 border-b">
        <nav className="flex gap-1 overflow-x-auto" aria-label="Case views">
          {CASE_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-current={v === view ? "page" : undefined}
              className={cn(
                "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap text-muted-foreground",
                v === view ? "border-foreground font-medium text-foreground" : "border-transparent hover:text-foreground",
              )}
              onClick={() => setSearch({ view: v })}
            >
              {viewLabel[v]}
              {counts && v !== "closed" && <span className="text-xs text-muted-foreground tabular-nums">{` ${counts[v]}`}</span>}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-3 pb-2">
          <Filter label="Status" id="filter-status" value={search.status} options={STATUSES} labels={statusLabel} onChange={(status) => setSearch({ status })} />
          <Filter label="Severity" id="filter-severity" value={search.severity} options={SEVERITIES} labels={severityLabel} onChange={(severity) => setSearch({ severity })} />
          <Filter label="Case Type" id="filter-type" value={search.caseType} options={CASE_TYPES} labels={caseTypeLabel} onChange={(caseType) => setSearch({ caseType })} />
          <Filter label="Tag" id="filter-tag" value={search.tag} options={tagOptions} labels={tagLabels} onChange={(tag) => setSearch({ tag })} />
        </div>
      </div>
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Case</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Case Type</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead className="pr-4">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cases.data?.cases.map((c) => (
              <TableRow key={c.number}>
                <TableCell className="pl-4 font-mono text-xs text-muted-foreground">
                  <Link to="/cases/$number" params={{ number: String(c.number) }} className="hover:underline">
                    {caseRef(c.number)}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <span className="flex items-center gap-1.5">
                    {c.restricted && <LockIcon className="size-3.5 shrink-0" role="img" aria-label="Restricted" />}
                    <Link to="/cases/$number" params={{ number: String(c.number) }} className="font-medium hover:underline">
                      {c.title}
                    </Link>
                  </span>
                  {c.tags.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {c.tags.map((t) => (
                        <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {tagLabel(t)}
                        </span>
                      ))}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={c.status} resolution={c.resolution} />
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={c.severity} />
                </TableCell>
                <TableCell>{caseTypeLabel[c.caseType]}</TableCell>
                <TableCell className={cn(!c.assignee && "text-muted-foreground")}>{c.assignee?.name ?? "Unassigned"}</TableCell>
                <TableCell className="pr-4 text-muted-foreground">{ago(c.updatedAt)}</TableCell>
              </TableRow>
            ))}
            {cases.data?.cases.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No Cases here.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function Filter<T extends string>({
  label,
  id,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  id: string;
  value: T | undefined;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <NativeSelect size="sm" id={id} value={value ?? ""} onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}>
        <NativeSelectOption value="">Any</NativeSelectOption>
        {options.map((o) => (
          <NativeSelectOption key={o} value={o}>
            {labels[o]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
