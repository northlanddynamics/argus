import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useMemo, useState } from "react";
import { ItemLink } from "@/components/item-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { CasePicker } from "@/routes/alerts/alert-dialogs";
import { bulkLookup, extractObservables, linkToCase, type LookupResult } from "@/lib/bulk-lookup";
import { caseRef, casesKey } from "@/lib/cases";
import { itemPagesKey, observableTypeLabel, shownObservable } from "@/lib/observables";

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const keyOf = (r: Pick<LookupResult, "type" | "value">) => `${r.type} ${r.value}`;

/**
 * Bulk Lookup: paste an email, a threat report or a list, and see every Observable in it, each known
 * (with the Cases and Alerts it appears in) or unknown; then link the chosen ones to a Case. Members
 * only. The count under the box comes from the same extraction the API runs.
 */
export function BulkLookupPage() {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const preview = useMemo(() => (deferred.trim() ? extractObservables(deferred) : null), [deferred]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState<{ number: number; linked: number; alreadyLinked: number } | null>(null);

  const lookup = useMutation({
    mutationFn: bulkLookup,
    onMutate: () => setNotice(null),
    onSuccess: (results) => setSelected(new Set(results.filter((r) => !r.known).map(keyOf))),
  });
  const results = lookup.data;
  const chosen = results?.filter((r) => selected.has(keyOf(r))) ?? [];
  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const allChosen = !!results?.length && chosen.length === results.length;

  return (
    <div className="mx-auto grid w-full max-w-page grid-cols-1 gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Bulk Lookup</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Paste an email, a threat report or a list. Argus finds every IP, domain, URL, email address and hash in it, defanged or not, and shows which
          ones your team has already seen.
        </p>
      </div>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (preview?.ok) lookup.mutate(text);
        }}
      >
        <Label htmlFor="lookup-text" className="sr-only">
          Text to look up
        </Label>
        <Textarea
          id="lookup-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste text here"
          className="max-h-96 min-h-40 font-mono text-sm"
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {!preview && "Up to 100 KB and 1,000 values at a time."}
            {preview?.ok && `${plural(preview.observables.length, "value")} found`}
          </p>
          <Button type="submit" disabled={!preview?.ok || !preview.observables.length || lookup.isPending}>
            {lookup.isPending ? "Looking up…" : "Look up"}
          </Button>
        </div>
        {preview && !preview.ok && (
          <Alert variant="destructive">
            <AlertDescription>{preview.reason}</AlertDescription>
          </Alert>
        )}
      </form>

      {lookup.isError && (
        <Alert variant="destructive">
          <AlertDescription>{lookup.error.message}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>
            <span>
              Linked {plural(notice.linked, "value")} to{" "}
              <Link to="/cases/$number/observables" params={{ number: String(notice.number) }} className="font-medium underline">
                {caseRef(notice.number)}
              </Link>
              {notice.alreadyLinked > 0 && ` (${notice.alreadyLinked.toLocaleString()} already linked)`}.
            </span>
          </AlertDescription>
        </Alert>
      )}

      {results && (
        <Card>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {plural(results.length, "value")} · {results.filter((r) => r.known).length.toLocaleString()} known ·{" "}
                {chosen.length.toLocaleString()} selected
              </p>
              <Button size="sm" disabled={!chosen.length} onClick={() => setLinking(true)}>
                Link to a Case…
              </Button>
            </div>
            <Table aria-label="Values found">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      aria-label="Select all"
                      checked={allChosen ? true : chosen.length ? "indeterminate" : false}
                      onCheckedChange={(on) => setSelected(on === true ? new Set(results.map(keyOf)) : new Set())}
                    />
                  </TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Seen</TableHead>
                  <TableHead className="hidden md:table-cell">Cases</TableHead>
                  <TableHead className="hidden md:table-cell">Alerts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <ResultRow key={keyOf(r)} result={r} selected={selected.has(keyOf(r))} onSelect={(on) => toggle(keyOf(r), on)} />
                ))}
                {!results.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      No IPs, domains, URLs, email addresses or hashes in that text.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <LinkDialog
        open={linking}
        onOpenChange={setLinking}
        chosen={chosen}
        onDone={async (number, outcome) => {
          setLinking(false);
          await queryClient.invalidateQueries({ queryKey: casesKey });
          await queryClient.invalidateQueries({ queryKey: itemPagesKey });
          // Look again, so what was just linked shows as known; the notice comes back once it has.
          lookup.mutate(lookup.variables ?? text, { onSettled: () => setNotice({ number, ...outcome }) });
        }}
      />
    </div>
  );
}

function ResultRow({ result: r, selected, onSelect }: { result: LookupResult; selected: boolean; onSelect: (on: boolean) => void }) {
  const shown = shownObservable(r.type, r.value);
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>
        <Checkbox aria-label={`Select ${r.value}`} checked={selected} onCheckedChange={(on) => onSelect(on === true)} />
      </TableCell>
      <TableCell className="max-w-0 min-w-48 font-mono text-sm break-all whitespace-normal" title={r.value}>
        {r.known ? (
          <ItemLink kind="observable" id={r.known.id} className="hover:underline">
            {shown}
          </ItemLink>
        ) : (
          shown
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{observableTypeLabel[r.type]}</TableCell>
      <TableCell>{r.known ? <Badge>Known</Badge> : <Badge variant="outline">Unknown</Badge>}</TableCell>
      <TableCell className="hidden max-w-64 whitespace-normal md:table-cell">
        {r.known?.cases.length ? (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5">
            {r.known.cases.slice(0, 5).map((c) => (
              <Link key={c.number} to="/cases/$number" params={{ number: String(c.number) }} className="font-mono text-xs hover:underline" title={c.title}>
                {caseRef(c.number)}
              </Link>
            ))}
            {r.known.cases.length > 5 && <span className="text-xs text-muted-foreground">+{r.known.cases.length - 5} more</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {r.known?.alerts.length ? (
          <span className="text-sm" title={r.known.alerts.map((a) => a.title).join("\n")}>
            {plural(r.known.alerts.length, "Alert")}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** "Link N values to a Case": an open Case the Member can see, as hand links. */
function LinkDialog({
  open,
  onOpenChange,
  chosen,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chosen: LookupResult[];
  onDone: (number: number, outcome: { linked: number; alreadyLinked: number }) => void;
}) {
  const [target, setTarget] = useState<number | null>(null);
  const link = useMutation({
    mutationFn: (number: number) => linkToCase(number, chosen.map(({ type, value }) => ({ type, value }))),
    onSuccess: (outcome, number) => onDone(number, outcome),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) {
          setTarget(null);
          link.reset();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link {plural(chosen.length, "value")} to a Case</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (target) link.mutate(target);
          }}
        >
          <CasePicker enabled={open} value={target === null ? null : String(target)} onChange={(v) => setTarget(Number(v))} />
          {link.isError && (
            <Alert variant="destructive">
              <AlertDescription>{link.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!target || link.isPending}>
              Link
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
