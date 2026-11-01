import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Visibility } from "@/components/visibility";
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
  /** Add the next files as Internal. */
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
    <Card>
      <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-2">
        <CardTitle>Evidence</CardTitle>
        <span className="text-xs text-muted-foreground">
          Fingerprinted on upload · never altered or deleted · every view and download is logged
        </span>
      </CardHeader>
      <CardContent className="grid gap-4">
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
            Drop files here or
            <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
              Choose files
            </Button>
            — SHA-256 computed on upload
            {canMarkInternal(c) && (
              <span className="ml-4 flex items-center gap-2">
                <Checkbox id="evidence-internal" checked={internal} onCheckedChange={(checked) => setInternal(checked === true)} />
                <Label htmlFor="evidence-internal">Add as Internal</Label>
              </span>
            )}
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
              <div className="h-1.5 overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${u.progress * 100}%` }} />
              </div>
            </div>
          ),
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>SHA-256</TableHead>
              {membersView && <TableHead>Visibility</TableHead>}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((e) => (
              <TableRow key={e.id} data-testid={`evidence-${e.name}`}>
                <TableCell className="font-medium whitespace-normal break-all">{e.name}</TableCell>
                <TableCell className="text-sm">{formatBytes(e.size)}</TableCell>
                <TableCell className="text-sm">
                  {e.addedBy.name} · {new Date(e.addedAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <code className="text-xs" title={e.sha256}>
                      {shortHash(e.sha256)}
                    </code>
                    <Button variant="outline" size="sm" aria-label={`Copy SHA-256 of ${e.name}`} onClick={() => void copy(e.sha256)}>
                      {copied === e.sha256 ? "Copied" : "Copy"}
                    </Button>
                  </span>
                </TableCell>
                {membersView && (
                  <TableCell>
                    <Visibility number={number} item={{ kind: "evidence", id: e.id }} internal={e.internal} label={e.name} canMark={canMarkInternal(c)} />
                  </TableCell>
                )}
                <TableCell className="text-right">
                  <span className="inline-flex gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a href={evidenceUrl(number, e.id, "view")} target="_blank" rel="noopener noreferrer" aria-label={`View ${e.name}`}>
                        View
                      </a>
                    </Button>
                    <Button asChild variant="outline" size="sm">
                      <a href={evidenceUrl(number, e.id, "download")} download={e.name} aria-label={`Download ${e.name}`}>
                        Download
                      </a>
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
            {evidence.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={membersView ? 6 : 5} className="text-muted-foreground">
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
