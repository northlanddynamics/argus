import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EnrichmentButton, ObservableText } from "@/components/observable-details";
import { CheckIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, FileIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Time } from "@/components/time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { RowIconButton } from "@/components/row-icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Audience, Visibility } from "@/components/visibility";
import { canMarkInternal, canParticipate, caseQuery } from "@/lib/cases";
import { evidenceKey, evidenceQuery, evidenceUrl, formatBytes, shortHash, uploadEvidence } from "@/lib/evidence";
import { useContainerWidth } from "@/hooks/use-container-width";
import { cn } from "@/lib/utils";
import { useCaseNumber } from "@/routes/cases/case-layout";

/** A file on its way up. */
type Upload = { key: string; name: string; progress: number; error: string | null };

/** A column that gives way on a narrow card: no width and no padding until it has room; its value shows under the file name. */
const fromMd = "overflow-hidden px-0 @md:px-2";
const from3xl = "overflow-hidden px-0 @3xl:px-2";
const from4xl = "overflow-hidden px-0 @4xl:px-2";
const from5xl = "overflow-hidden px-0 @5xl:px-2";
const from6xl = "overflow-hidden px-0 @6xl:px-2";

/**
 * Case · Evidence: files added to the Case, fingerprinted, never altered, every access logged. Guests
 * add files too; Members see which are Internal and can add files as Internal.
 */
export function CaseEvidencePage() {
  const number = useCaseNumber();
  const queryClient = useQueryClient();
  const { data: c } = useQuery(caseQuery(number));
  const evidence = useQuery(evidenceQuery(number));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** Add the next files as Internal; reset after each batch, so it never carries over unnoticed. */
  const [internal, setInternal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { ref, fits } = useContainerWidth<HTMLDivElement>();

  const update = (key: string, change: Partial<Upload>) =>
    setUploads((all) => all.map((u) => (u.key === key ? { ...u, ...change } : u)));

  const add = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const key = crypto.randomUUID();
      setUploads((all) => [...all, { key, name: file.name, progress: 0, error: null }]);
      uploadEvidence(number, file, internal, (progress) => update(key, { progress }))
        .then(() => {
          setUploads((all) => all.filter((u) => u.key !== key));
          void queryClient.invalidateQueries({ queryKey: evidenceKey(number) });
        })
        .catch((e: unknown) => update(key, { error: e instanceof Error ? e.message : `Could not add ${file.name}` }));
    }
    setInternal(false);
  };

  const copy = async (sha256: string) => {
    await navigator.clipboard.writeText(sha256);
    setCopied(sha256);
  };

  if (!c) return null;
  const participating = canParticipate(c);
  /** Guests see only what isn't Internal, so they get no Visibility column. */
  const membersView = c.can.markInternal;
  const list = evidence.data ?? [];
  const hash = (e: (typeof list)[number]) => (
    <span className="flex items-center gap-1">
      {/* Members open what VirusTotal knows about the file in the Enrichment panel; Guests see the whole hash on hover. */}
      {membersView ? (
        <ObservableText type="sha256" value={e.sha256} label={`SHA-256 ${e.sha256}`} className="no-underline hover:underline">
          {shortHash(e.sha256)}
        </ObservableText>
      ) : (
        <code tabIndex={0} className="font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50" title={e.sha256} aria-label={`SHA-256 ${e.sha256}`}>
          {shortHash(e.sha256)}
        </code>
      )}
      <EnrichmentButton type="sha256" value={e.sha256} />
      <RowIconButton label={copied === e.sha256 ? "Copied" : "Copy SHA-256"} aria-label={`Copy SHA-256 of ${e.name}`} onClick={() => void copy(e.sha256)}>
        {copied === e.sha256 ? <CheckIcon /> : <CopyIcon />}
      </RowIconButton>
    </span>
  );
  const visibility = (e: (typeof list)[number]) => (
    <Visibility number={number} item={{ kind: "evidence", id: e.id }} internal={e.internal} label={e.name} canMark={canMarkInternal(c)} />
  );
  return (
    <Card ref={ref} className="@container">
      <CardHeader>
        <CardTitle>Evidence</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {participating && canMarkInternal(c) && (
          <Field orientation="horizontal" className="w-auto">
            <Checkbox id="evidence-internal" checked={internal} onCheckedChange={(checked) => setInternal(checked === true)} />
            <FieldLabel htmlFor="evidence-internal">Add the next files as Internal (hidden from Guests)</FieldLabel>
          </Field>
        )}
        {participating && (
          <div
            className={cn(
              "flex flex-wrap items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-sm text-muted-foreground",
              dragging && "border-primary bg-primary/5",
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              add(e.dataTransfer.files);
            }}
          >
            {internal ? "Drop files to add as Internal, or" : "Drop files here or"}
            <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
              {internal ? "Choose Internal files" : "Choose files"}
            </Button>
            {canMarkInternal(c) && <Audience number={number} internal={internal} className="basis-full justify-center" />}
            <input
              ref={input}
              type="file"
              multiple
              hidden
              aria-label="Evidence files"
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        )}
        {uploads.map((u) =>
          u.error ? (
            <Alert key={u.key} variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-2">
                {u.error}
                <Button variant="ghost" size="sm" onClick={() => setUploads((all) => all.filter((x) => x.key !== u.key))}>
                  Dismiss
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div key={u.key} className="grid gap-1 text-sm" role="status">
              <span>
                Adding {u.name} · {Math.round(u.progress * 100)}%
              </span>
              <Progress value={u.progress * 100} aria-label={`Adding ${u.name}`} />
            </div>
          ),
        )}
        <Table className="table-fixed" data-enrichment-list>
          {/* Set widths, so the columns line up row to row. On a narrow card they give way, who added it
              first, and show under the file name instead; on a wide page File stops at 36rem and the last
              column takes the slack, keeping the rest beside the name. */}
          <colgroup>
            <col className="@7xl:w-[36rem]" />
            <col className="w-0 @md:w-24" />
            <col className="w-0 @6xl:w-40" />
            <col className="w-0 @5xl:w-32" />
            <col className="w-0 @3xl:w-44" />
            {membersView && <col className="w-0 @4xl:w-44" />}
            <col className="w-20 @7xl:w-auto" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>File</TableHead>
              <TableHead className={cn(fromMd, "text-right")}>{fits("md") && "Size"}</TableHead>
              <TableHead className={from6xl}>{fits("6xl") && "Added by"}</TableHead>
              <TableHead className={from5xl}>{fits("5xl") && "Added"}</TableHead>
              <TableHead className={from3xl}>{fits("3xl") && "SHA-256"}</TableHead>
              {membersView && <TableHead className={from4xl}>{fits("4xl") && "Visibility"}</TableHead>}
              <TableHead>
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {evidence.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={membersView ? 7 : 6}>
                  <Skeleton className="h-8" />
                </TableCell>
              </TableRow>
            )}
            {list.map((e) => (
              <TableRow key={e.id} data-testid={`evidence-${e.name}`} className="group/row">
                <TableCell className="whitespace-normal">
                  <span className="flex items-start gap-2">
                    <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="grid min-w-0 gap-1">
                      <span className="font-medium [overflow-wrap:anywhere]">{e.name}</span>
                      {/* What the columns that have given way hold, under the file name. */}
                      {!fits("6xl") && (
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {!fits("md") && <span className="tabular-nums">{formatBytes(e.size)}</span>}
                          <span className="text-foreground">{e.addedBy.name}</span>
                          {!fits("5xl") && <Time iso={e.addedAt} />}
                          {!fits("3xl") && hash(e)}
                          {membersView && !fits("4xl") && visibility(e)}
                        </span>
                      )}
                    </span>
                  </span>
                </TableCell>
                <TableCell className={cn(fromMd, "text-right text-muted-foreground tabular-nums")}>{fits("md") && formatBytes(e.size)}</TableCell>
                <TableCell className={cn(from6xl, "truncate")} title={e.addedBy.name}>
                  {fits("6xl") && e.addedBy.name}
                </TableCell>
                <TableCell className={cn(from5xl, "truncate text-muted-foreground")}>{fits("5xl") && <Time iso={e.addedAt} />}</TableCell>
                <TableCell className={from3xl}>{fits("3xl") && hash(e)}</TableCell>
                {membersView && <TableCell className={from4xl}>{fits("4xl") && visibility(e)}</TableCell>}
                <TableCell className="text-right @7xl:text-left">
                  <span className="inline-flex gap-1">
                    <RowIconButton label="View in a new tab" asChild>
                      <a href={evidenceUrl(number, e.id, "view")} target="_blank" rel="noopener noreferrer" aria-label={`View ${e.name}`}>
                        <ExternalLinkIcon />
                      </a>
                    </RowIconButton>
                    <RowIconButton label="Download" asChild>
                      <a href={evidenceUrl(number, e.id, "download")} download={e.name} aria-label={`Download ${e.name}`}>
                        <DownloadIcon />
                      </a>
                    </RowIconButton>
                  </span>
                </TableCell>
              </TableRow>
            ))}
            {evidence.data?.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={membersView ? 7 : 6} className="text-muted-foreground">
                  No Evidence yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
