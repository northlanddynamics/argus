import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { StatusBadge } from "@/components/case-badges";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { api, errorMessage } from "@/lib/api";
import { LINK_TYPES, type LinkType, linkSideLabel, linksKey, linksQuery } from "@/lib/case-links";
import { caseKey, caseRef, casesKey } from "@/lib/cases";
import { cn } from "@/lib/utils";

/** Case page · Linked Cases: the Cases this one is linked to that the Member can see. */
export function LinkedCasesPanel({ number, readOnly }: { number: number; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const links = useQuery(linksQuery(number));

  const unlink = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.cases[":number"].links[":id"].$delete({ param: { number: String(number), id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not remove the link"));
      const body = await res.json();
      if (!("links" in body)) throw new Error("Could not remove the link");
      return body.links;
    },
    onSuccess: (next) => queryClient.setQueryData(linksKey(number), next),
  });

  return (
    <Card className="self-start">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-xs tracking-widest text-muted-foreground uppercase">Linked Cases</CardTitle>
        {!readOnly && <LinkCaseDialog number={number} />}
      </CardHeader>
      <CardContent className="grid gap-3">
        {links.data?.length ? (
          <ul className="grid gap-2 text-sm" aria-label="Linked Cases">
            {links.data.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{linkSideLabel[l.side]}</span>
                <span className="flex min-w-0 items-center gap-1">
                  <Link
                    to="/cases/$number"
                    params={{ number: String(l.case.number) }}
                    className="truncate font-mono text-xs text-primary underline"
                    title={l.case.title}
                  >
                    {caseRef(l.case.number)}
                  </Link>
                  <StatusBadge status={l.case.status} resolution={l.case.resolution} />
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove link to ${caseRef(l.case.number)}`}
                      disabled={unlink.isPending}
                      onClick={() => unlink.mutate(l.id)}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Not linked to any Case.</p>
        )}
        {unlink.error && (
          <Alert variant="destructive">
            <AlertDescription>{unlink.error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

const linkTypeLabel: Record<LinkType, string> = {
  related: "Related",
  duplicate_of: "Duplicate of",
  parent_of: "Parent of",
  child_of: "Child of",
};

/** "Link to another Case": a link type and a Case the Member can see. Duplicate of closes this Case. */
function LinkCaseDialog({ number }: { number: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [type, setType] = useState<LinkType>("related");
  const [target, setTarget] = useState("");
  const queryClient = useQueryClient();

  // Only Cases the Member can see are offered: the list already leaves out the rest.
  const candidates = useQuery({
    queryKey: [...casesKey, "link-candidates"],
    queryFn: async () => {
      const [open, closed] = await Promise.all(
        (["open", "closed"] as const).map(async (view) => {
          const res = await api.cases.$get({ query: { view } });
          if (!res.ok) throw new Error("Could not load Cases");
          return (await res.json()).cases;
        }),
      );
      return [...open!, ...closed!].filter((c) => c.number !== number).toSorted((a, b) => b.number - a.number);
    },
    enabled: isOpen,
  });

  const link = useMutation({
    mutationFn: async (json: { type: LinkType; case: number }) => {
      const res = await api.cases[":number"].links.$post({ param: { number: String(number) }, json });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not link the Cases"));
      const body = await res.json();
      if (!("links" in body)) throw new Error("Could not link the Cases");
      return body;
    },
    onSuccess: ({ links, closed }) => {
      queryClient.setQueryData(linksKey(number), links);
      if (closed) void queryClient.invalidateQueries({ queryKey: caseKey(number) });
      void queryClient.invalidateQueries({ queryKey: casesKey });
      setIsOpen(false);
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (target) link.mutate({ type, case: Number(target) });
  };

  const duplicate = type === "duplicate_of";
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) {
          setType("related");
          setTarget("");
          link.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          + Link
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link {caseRef(number)} to another Case</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Link type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {LINK_TYPES.map((t) => (
                <label
                  key={t}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
                    type === t && "border-primary ring-1 ring-primary",
                  )}
                >
                  <input type="radio" name="linkType" value={t} checked={type === t} onChange={() => setType(t)} />
                  {linkTypeLabel[t]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor="link-target">Target Case</Label>
            <NativeSelect id="link-target" required value={target} onChange={(e) => setTarget(e.target.value)}>
              <NativeSelectOption value="" disabled>
                Choose a Case…
              </NativeSelectOption>
              {candidates.data?.map((c) => (
                <NativeSelectOption key={c.number} value={String(c.number)}>
                  {caseRef(c.number)} {c.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {duplicate && (
            <Alert className="border-amber-300 bg-amber-50 text-amber-950">
              <AlertDescription>
                Marking as Duplicate of {target ? caseRef(Number(target)) : "another Case"} closes {caseRef(number)} now with Resolution
                Duplicate.
              </AlertDescription>
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">Recorded in both Cases’ Audit Logs. Cases you can’t see aren’t offered.</p>
          {link.error && (
            <Alert variant="destructive">
              <AlertDescription>{link.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!target || link.isPending}>
              {duplicate ? "Link and close" : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
