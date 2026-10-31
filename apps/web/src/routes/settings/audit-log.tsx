import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { membersKey } from "@/routes/settings/members";

const categories = { members: "Members", "case-roles": "Case Roles", sso: "Single sign-on", integrations: "Integrations", teams: "Teams" } as const;
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

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Organization Audit Log</h1>
        <p className="text-sm text-muted-foreground">Admins and the Owner only · append-only</p>
      </div>
      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="audit-category">Category</Label>
            <NativeSelect id="audit-category" value={category} onChange={(e) => setCategory(e.target.value as Category | "")}>
              <NativeSelectOption value="">All</NativeSelectOption>
              {Object.entries(categories).map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="audit-actor">Actor</Label>
            <NativeSelect id="audit-actor" value={actor} onChange={(e) => setActor(e.target.value)}>
              <NativeSelectOption value="">Anyone</NativeSelectOption>
              {members.data?.members.map((m) => (
                <NativeSelectOption key={m.userId} value={m.userId}>
                  {m.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="audit-from">From</Label>
            <Input id="audit-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Before → After</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data?.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{new Date(e.occurredAt).toLocaleString()}</TableCell>
                  <TableCell>{e.actor.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{categories[e.category] ?? e.category}</Badge>
                  </TableCell>
                  <TableCell>{describe(e.action, e.target)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <span className={e.before ? "line-through" : undefined}>{word(e.before)}</span> → {word(e.after)}
                  </TableCell>
                </TableRow>
              ))}
              {entries.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    Nothing recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
