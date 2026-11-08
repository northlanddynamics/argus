import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HashHoverCard } from "@/components/hash-details";
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
import { cn } from "@/lib/utils";
import { useCaseNumber } from "@/routes/cases/case-layout";

/** A file on its way up. */
type Upload = { key: string; name: string; progress: number; error: string | null };

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
  return (
    <Card className="@container">
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
        <Table className="@4xl:table-fixed">
          {/* Set widths, so the File name takes what's left and the rest line up row to row. */}
          <colgroup>
            <col />
            <col className="@4xl:w-24" />
            <col className="@4xl:w-40" />
            <col className="@4xl:w-32" />
            <col className="@4xl:w-44" />
            {membersView && <col className="@4xl:w-44" />}
            <col className="@4xl:w-20" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>File</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Added by</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>SHA-256</TableHead>
              {membersView && <TableHead>Visibility</TableHead>}
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
                <TableCell className="min-w-48 whitespace-normal">
                  <span className="flex items-start gap-2">
                    <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-medium [overflow-wrap:anywhere]">{e.name}</span>
                  </span>
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{formatBytes(e.size)}</TableCell>
                <TableCell className="truncate" title={e.addedBy.name}>
                  {e.addedBy.name}
                </TableCell>
                <TableCell className="truncate text-muted-foreground">
                  <Time iso={e.addedAt} />
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1">
                    {/* Members see the whole hash, and what VirusTotal knows about the file, on hover; Guests get no popup, so the title shows it. */}
                    <HashHoverCard hash={e.sha256}>
                      <code
                        tabIndex={0}
                        className="font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        title={membersView ? undefined : e.sha256}
                        aria-label={`SHA-256 ${e.sha256}`}
                      >
                        {shortHash(e.sha256)}
                      </code>
                    </HashHoverCard>
                    <RowIconButton label={copied === e.sha256 ? "Copied" : "Copy SHA-256"} aria-label={`Copy SHA-256 of ${e.name}`} onClick={() => void copy(e.sha256)}>
                      {copied === e.sha256 ? <CheckIcon /> : <CopyIcon />}
                    </RowIconButton>
                  </span>
                </TableCell>
                {membersView && (
                  <TableCell>
                    <Visibility number={number} item={{ kind: "evidence", id: e.id }} internal={e.internal} label={e.name} canMark={canMarkInternal(c)} />
                  </TableCell>
                )}
                <TableCell className="text-right">
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
