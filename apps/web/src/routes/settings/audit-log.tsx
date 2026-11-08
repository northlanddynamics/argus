import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/date-picker";
import { DATE_FILTER, FilterBar, FilterField, FilterSelect } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { membersKey } from "@/routes/settings/members";

const categories = { members: "Members", "case-roles": "Case Roles", sso: "Single sign-on", integrations: "Integrations", alerts: "Alerts", teams: "Teams", "ignored-observables": "Ignored Observables" } as const;
type Category = keyof typeof categories;

const actionLabels: Record<string, string> = {
  "organization.created": "Organization created; Owner invited",
  "organization.deleted": "Deleted the Organization",
  "member.invited": "Invited",
  "invitation.revoked": "Revoked the invite of",
  "member.joined": "Joined",
  "member.role_changed": "Changed role of",
  "member.removed": "Removed",
  "ownership.transferred": "Transferred ownership to",
  "case_role.created": "Created Case Role",
  "case_role.renamed": "Renamed Case Role",
  "case_role.retired": "Retired Case Role",
  "integration.created": "Added Integration",
  "integration.credentials_rotated": "Rotated the credentials of",
  "integration.paused": "Paused Integration",
  "integration.resumed": "Resumed Integration",
  "integration.write_back_enabled": "Turned on write-back to Falcon for",
  "integration.write_back_disabled": "Turned off write-back to Falcon for",
  "integration.response_actions_enabled": "Turned on Response Actions for",
  "integration.response_actions_disabled": "Turned off Response Actions for",
  "integration.response_action_defaults_changed": "Changed Response Action defaults for",
  "integration.host_containment_enabled": "Turned on Host containment for",
  "integration.host_containment_disabled": "Turned off Host containment for",
  "integration.stream_gap": "Gap in the stream of",
  "sso.enabled": "Enabled single sign-on",
  "sso.changed": "Changed single sign-on",
  "sso.disabled": "Disabled single sign-on",
  "teams.webhook_set": "Set the webhook of the",
  "teams.webhook_changed": "Replaced the webhook of the",
  "teams.webhook_removed": "Removed the webhook of the",
  "ignored_observable.added": "Added to the Ignored list:",
  "ignored_observable.removed": "Removed from the Ignored list:",
  "alert.dismissed": "Dismissed Alert",
  "alert.falcon_status_changed": "Changed Falcon status of Alert",
  "alert.falcon_assignee_changed": "Changed Falcon assignee of Alert",
  "alert.falcon_tags_changed": "Changed Falcon tags of Alert",
};

/** Describes an entry: "Changed role of J. Okafor". The creation entry already names its target in "after". */
const describe = (action: string, target: string | null) =>
  action === "organization.created" ? actionLabels[action] : [actionLabels[action] ?? action, target].filter(Boolean).join(" ");

const roleWords: Record<string, string> = { owner: "Owner", admin: "Admin", analyst: "Analyst" };
const word = (value: string | null) => (value === null ? "—" : (roleWords[value] ?? value));

export function OrgAuditLogPage() {
  const [category, setCategory] = useState<Category | "">("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");

  const entries = useQuery({
    queryKey: ["organization", "audit-log", { category, actor, from }],
    queryFn: async () => {
      const query = {
        ...(category && { category }),
        ...(actor && { actor }),
        // A date picked in the browser means midnight where the viewer is.
        ...(from && { from: new Date(`${from}T00:00`).toISOString() }),
      };
      const res = await api.organization["audit-log"].$get({ query });
      const body = await res.json();
      if (!("entries" in body)) throw new Error("Could not load the Organization Audit Log");
      return body.entries;
    },
  });
  const members = useQuery({
    queryKey: membersKey,
    queryFn: async () => (await api.organization.members.$get()).json(),
  });
  const actors = members.data?.members.map((m) => m.userId) ?? [];
  const actorNames = Object.fromEntries(members.data?.members.map((m) => [m.userId, m.name]) ?? []);
  const filtered = Boolean(category || actor || from);
  const clear = () => {
    setCategory("");
    setActor("");
    setFrom("");
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Organization Audit Log</h1>
      <FilterBar onClear={filtered ? clear : undefined}>
        <FilterSelect
          label="Category"
          id="audit-category"
          any="All"
          value={category || undefined}
          options={Object.keys(categories) as Category[]}
          labels={categories}
          onChange={(next) => setCategory(next ?? "")}
        />
        <FilterSelect label="Actor" id="audit-actor" any="Anyone" value={actor || undefined} options={actors} labels={actorNames} onChange={(next) => setActor(next ?? "")} />
        <FilterField label="From" htmlFor="audit-from">
          <DatePicker id="audit-from" value={from} onChange={setFrom} placeholder="Any time" className={DATE_FILTER} />
        </FilterField>
      </FilterBar>
      <Card className="@container py-0">
        <Table className="@4xl:table-fixed" aria-label="Organization Audit Log">
          {/* Set widths, so the columns hold still as filters change what's listed; Action takes the rest. */}
          <colgroup>
            <col className="@4xl:w-36" />
            <col className="@4xl:w-36" />
            <col className="@4xl:w-32" />
            <col />
            <col className="@4xl:w-[26%]" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="pr-4">Before → After</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.isPending &&
              Array.from({ length: 6 }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent" aria-hidden>
                  <TableCell className="pl-4"><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-3/5" /></TableCell>
                  <TableCell className="pr-4"><Skeleton className="h-4 w-2/5" /></TableCell>
                </TableRow>
              ))}
            {entries.data?.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="truncate pl-4 text-muted-foreground">
                  <Time iso={e.occurredAt} />
                </TableCell>
                <TableCell className="truncate" title={e.actor.name}>{e.actor.name}</TableCell>
                <TableCell>
                  <Badge variant="outline">{categories[e.category] ?? e.category}</Badge>
                </TableCell>
                <TableCell className="min-w-48 whitespace-normal [overflow-wrap:anywhere]">{describe(e.action, e.target)}</TableCell>
                <TableCell className="pr-4 font-mono text-xs whitespace-normal [overflow-wrap:anywhere]">
                  {e.before !== null && <span className="text-muted-foreground line-through">{word(e.before)}</span>}
                  {e.before !== null && " "}→ {word(e.after)}
                </TableCell>
              </TableRow>
            ))}
            {entries.isError && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-4 whitespace-normal">
                  <span className="text-destructive">The Audit Log couldn't be loaded.</span>{" "}
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void entries.refetch()}>
                    Try again
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {entries.data?.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-4 text-muted-foreground">
                  {filtered ? "No entries match these filters." : "Nothing recorded yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
