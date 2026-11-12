import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AlertMenu } from "@/components/alert-menu";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
import { ItemLink } from "@/components/item-link";
import { EnrichmentButton } from "@/components/observable-details";
import { ItemContext, itemReference } from "@/components/item-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AlertCorrelation,
  alertCorrelationsQuery,
  type AlertDetail,
  alertKindLabel,
  alertQuery,
  alertsKey,
  alertStatusLabel,
  dismissalReasonLabel,
  falconStatusLabel,
} from "@/lib/alerts";
import { api } from "@/lib/api";
import { caseRef } from "@/lib/cases";
import { assetTypeLabel, type ItemKind, type ObservableType, observableTypeLabel, shownObservable } from "@/lib/observables";
import { cn } from "@/lib/utils";
import { exactTime } from "@/lib/when";
import { MoveAlertDialog } from "@/routes/alerts/alert-dialogs";

/** What the Alert queue does with an Alert that isn't on a Case. */
export type AlertAction = "open" | "attach" | "dismiss";

/** The Alert's comments in Falcon, as last fetched; opening the Alert asks the worker to fetch them again. */
function FalconComments({ comments: c }: { comments: AlertDetail["falconComments"] }) {
  /** Refreshing for longer than Falcon usually takes: the worker may be down or Falcon unreachable. */
  // The fetch it has been waiting on since, keyed by when comments were last fetched: a new refresh starts unflagged.
  const [slowSince, setSlowSince] = useState<string | null | false>(false);
  const slow = c.refreshing && slowSince === c.syncedAt;
  useEffect(() => {
    if (!c.refreshing) return;
    const timer = setTimeout(() => setSlowSince(c.syncedAt), 20_000);
    return () => clearTimeout(timer);
  }, [c.refreshing, c.syncedAt]);
  return (
    <section aria-label="Comments in Falcon" className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Comments in Falcon</h3>
        {c.refreshing ? (
          <span role="status" className="text-xs text-muted-foreground">
            {slow ? "Falcon hasn't answered yet; these may be out of date" : "Refreshing from Falcon…"}
          </span>
        ) : (
          c.syncedAt && (
            <span className="text-xs text-muted-foreground">
              Fetched <time dateTime={c.syncedAt}>{new Date(c.syncedAt).toLocaleTimeString()}</time>
            </span>
          )
        )}
      </div>
      {c.error && <p className="text-xs text-destructive">Couldn’t fetch comments: {c.error}</p>}
      {c.comments.length ? (
        <ul className="grid gap-2">
          {c.comments.map((comment) => (
            <li key={comment.id} className="rounded border p-2">
              <p className="text-xs text-muted-foreground">
                CrowdStrike: {comment.author ?? "unknown user"}
                {comment.createdAt && ` · ${new Date(comment.createdAt).toLocaleString()}`}
              </p>
              <p className="whitespace-pre-wrap">{comment.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        !c.refreshing && <p className="text-muted-foreground">None</p>
      )}
    </section>
  );
}

/**
 * The host or account an Alert's detection names, as a link to its Asset page with the Asset's hover
 * card when Argus holds it, as plain text when it doesn't, and "None" when there is none.
 */
function SubjectAsset({ type, value, asset }: { type: "host" | "account"; value: string | null; asset: { id: string } | null }) {
  if (value === null) return "None";
  if (!asset) return value;
  return (
    <ItemContext item={{ kind: "asset", id: asset.id, type, value }}>
      <ItemLink kind="asset" id={asset.id} className="hover:underline" aria-label={`${type === "host" ? "Host" : "Account"} ${value}`}>
        {value}
      </ItemLink>
    </ItemContext>
  );
}

/** Observables or Assets an Alert names, as badges. */
function Extracted({
  label,
  kind,
  items,
}: {
  label: string;
  kind: ItemKind;
  items: { id: string; text: string; title: string; type: string; value: string }[];
}) {
  return (
    <section aria-label={label} className="grid gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      {items.length ? (
        <div className="flex flex-wrap gap-1" data-enrichment-list>
          {items.map((item) => (
            <span key={item.id} className="group/row inline-flex max-w-full items-center">
              <ItemContext item={itemReference(kind, item)}>
                <Badge variant="outline" className="max-w-full truncate font-mono" title={item.title} asChild>
                  <ItemLink kind={kind} id={item.id}>
                    {item.text}
                  </ItemLink>
                </Badge>
              </ItemContext>
              {kind === "observable" && <EnrichmentButton type={item.type as ObservableType} value={item.value} className="size-5" />}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">None</p>
      )}
    </section>
  );
}

/**
 * Correlation: the Cases this Alert may belong with, by the Important Observables and the Assets they
 * share (those on the Ignored list aside), strongest first. Argus never attaches on its own: the Member attaches
 * from a suggestion, or for a Closed Case an Admin reopens it and attaches in one step; an Analyst
 * only gets the link.
 */
function RelatedCases({ alert }: { alert: AlertDetail }) {
  const related = useQuery(alertCorrelationsQuery(alert.id));
  const queryClient = useQueryClient();
  const attach = useMutation({
    mutationFn: async (c: AlertCorrelation) => {
      const res = await api.alerts.attach.$post({
        json: { case: c.case.number, alerts: [{ id: alert.id, version: alert.version }], reopen: c.attach === "reopen_and_attach" },
      });
      const body = (await res.json()) as { error?: string; refused?: { externalId: string | null; detail: string }[] };
      if (!res.ok) throw new Error(body.error ?? "Couldn't attach the Alert");
      const refused = body.refused?.[0];
      if (refused) throw new Error(`${refused.externalId ?? "The Alert"} ${refused.detail}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: alertsKey }),
  });
  const list = related.data ?? [];
  return (
    <section aria-label="Related Cases" className="grid gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">Related Cases</h3>
      {related.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : related.isError ? (
        <p className="text-destructive">Couldn’t load the related Cases.</p>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground">No other Case shares its Important Observables or its Assets.</p>
      ) : (
        <ul className="grid gap-2">
          {list.map((c) => (
            <li key={c.case.number} className="grid gap-1.5 rounded border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/cases/$number"
                  params={{ number: String(c.case.number) }}
                  className="min-w-0 font-medium underline-offset-4 hover:underline"
                >
                  <span className="font-mono text-xs">{caseRef(c.case.number)}</span> {c.case.title}
                </Link>
                <StatusBadge status={c.case.status} />
                <span className="ml-auto text-xs text-muted-foreground">{c.sharedCount} shared</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {c.shared.map((s) => (
                  <ItemContext key={`${s.kind}-${s.id}`} item={itemReference(s.kind, s)}>
                      <Badge variant="outline" className="max-w-full truncate font-mono" title={s.value} asChild>
                        <ItemLink kind={s.kind} id={s.id}>
                          {s.kind === "observable"
                            ? `${observableTypeLabel[s.type]} ${shownObservable(s.type, s.value)}`
                            : `${assetTypeLabel[s.type]} ${s.value}`}
                        </ItemLink>
                      </Badge>
                  </ItemContext>
                ))}
              </div>
              {c.attach ? (
                <div>
                  <Button size="sm" variant="outline" disabled={attach.isPending} onClick={() => attach.mutate(c)}>
                    {c.attach === "reopen_and_attach" ? `Reopen ${caseRef(c.case.number)} and attach` : `Attach to ${caseRef(c.case.number)}`}
                  </Button>
                </div>
              ) : (
                c.case.status === "closed" &&
                alert.attached?.case.status !== "closed" && <p className="text-xs text-muted-foreground">Closed: ask an Admin to reopen it to attach this Alert.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {attach.error && <p className="text-xs text-destructive">{attach.error.message}</p>}
    </section>
  );
}

/**
 * One Alert in full: Open Case, Attach and Dismiss while it isn't on a Case (where `onAct` takes
 * them), Move and Detach while it is on an open one. The Alert queue shows it beside the queue, the
 * Case page in a flyout; each gives it its own frame.
 */
export function AlertDetails({ id, onClose, onAct }: { id: string; onClose: () => void; onAct?: (kind: AlertAction, alert: AlertDetail) => void }) {
  const alert = useQuery(alertQuery(id));
  const [moving, setMoving] = useState<"move" | "detach" | null>(null);
  const a = alert.data;
  if (alert.isPending) {
    return (
      <div aria-busy className="grid gap-3">
        <span className="sr-only" role="status">
          Loading the Alert…
        </span>
        <div className="flex justify-between">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (!a) {
    return (
      <div className="grid gap-3">
        {alert.isError ? (
          <>
            <p className="font-medium">This Alert couldn't be loaded</p>
            <p className="text-muted-foreground">Try again, or reload the page.</p>
          </>
        ) : (
          <>
            <p className="font-medium">This Alert isn't available</p>
            <p className="text-muted-foreground">It may have been removed from the queue, or the link may be wrong.</p>
          </>
        )}
        <div className="flex gap-2">
          {alert.isError && (
            <Button size="sm" variant="outline" disabled={alert.isFetching} onClick={() => alert.refetch()}>
              Try again
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  const onCase = a.attached?.case ?? null;
  const editable = onCase !== null && onCase.status !== "closed";
  const actions = onAct && a.status !== "attached";
  return (
      <div className="grid gap-3">
        <div className="flex items-center gap-2">
          <SeverityBadge severity={a.severity} />
          <Badge variant="outline">{alertStatusLabel[a.status]}</Badge>
          {onCase && (
            <Link
              to="/cases/$number"
              params={{ number: String(onCase.number) }}
              className="font-mono text-xs underline underline-offset-4"
              title={onCase.title}
            >
              {caseRef(onCase.number)}
            </Link>
          )}
          <Button size="icon-sm" variant="ghost" className="-my-1 ml-auto" aria-label="Close the Alert" onClick={onClose}>
            <XIcon aria-hidden />
          </Button>
        </div>
        <AlertMenu falconUrl={a.falconUrl}>
          <div>
            <h2 className="text-base font-semibold text-balance">{a.title}</h2>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{a.externalId}</span> · {alertKindLabel[a.kind]} · {a.integration.name}
            </p>
          </div>
        </AlertMenu>
        {a.description && <p>{a.description}</p>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Host</dt>
          <dd className={cn("min-w-0 break-all", a.host ? "font-mono text-xs leading-5" : "text-muted-foreground")}>
            <SubjectAsset type="host" value={a.host} asset={a.hostAsset} />
          </dd>
          <dt className="text-muted-foreground">User</dt>
          <dd className={cn("min-w-0 break-all", a.userName ? "font-mono text-xs leading-5" : "text-muted-foreground")}>
            <SubjectAsset type="account" value={a.userName} asset={a.userAsset} />
          </dd>
          <dt className="text-muted-foreground">Received</dt>
          <dd>{exactTime(a.receivedAt)}</dd>
          {a.attached && (
            <>
              <dt className="text-muted-foreground">Attached</dt>
              <dd>
                {onCase ? caseRef(onCase.number) : "to a Case you can’t see"}
                {a.attached.by && ` by ${a.attached.by.name}`}
              </dd>
            </>
          )}
          {a.dismissed && (
            <>
              <dt className="text-muted-foreground">Dismissed</dt>
              <dd>
                {dismissalReasonLabel[a.dismissed.reason]}
                {a.dismissed.by && ` by ${a.dismissed.by.name}`}
                {a.dismissed.comment && <span className="block text-muted-foreground">“{a.dismissed.comment}”</span>}
              </dd>
            </>
          )}
          {a.falcon.status && (
            <>
              <dt className="text-muted-foreground">In Falcon</dt>
              <dd>{falconStatusLabel[a.falcon.status] ?? a.falcon.status}</dd>
            </>
          )}
          {a.falcon.assignee && (
            <>
              <dt className="text-muted-foreground">Falcon assignee</dt>
              <dd>{a.falcon.assignee}</dd>
            </>
          )}
          {a.falcon.tags.length > 0 && (
            <>
              <dt className="text-muted-foreground">Falcon tags</dt>
              <dd className="flex flex-wrap gap-1">
                {a.falcon.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </dd>
            </>
          )}
        </dl>
        <Extracted
          label="Extracted Observables"
          kind="observable"
          items={a.indicators.observables.map((o) => ({ id: o.id, text: `${observableTypeLabel[o.type]} ${shownObservable(o.type, o.value)}`, title: o.value, type: o.type, value: o.value }))}
        />
        <Extracted
          label="Extracted Assets"
          kind="asset"
          items={a.indicators.assets.map((x) => ({ id: x.id, text: `${assetTypeLabel[x.type]} ${x.value}`, title: x.value, type: x.type, value: x.value }))}
        />
        {a.indicators.observables.length + a.indicators.assets.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {onCase ? `These are on ${caseRef(onCase.number)} too.` : "Attaching this Alert adds these to its Case."}
          </p>
        )}
        <RelatedCases alert={a} />
        <FalconComments comments={a.falconComments} />
        <details>
          <summary className="cursor-pointer text-muted-foreground">Raw payload</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(a.payload, null, 2)}</pre>
        </details>
        {(actions || editable) && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {actions && (
              <>
                <Button size="sm" onClick={() => onAct?.("open", a)}>
                  Open Case
                </Button>
                <Button size="sm" variant="outline" onClick={() => onAct?.("attach", a)}>
                  Attach to Case…
                </Button>
                {a.status === "new" && (
                  <Button size="sm" variant="outline" onClick={() => onAct?.("dismiss", a)}>
                    Dismiss…
                  </Button>
                )}
              </>
            )}
            {editable && (
              <>
                <Button size="sm" variant="outline" onClick={() => setMoving("move")}>
                  Move to another Case…
                </Button>
                <Button size="sm" variant="outline" onClick={() => setMoving("detach")}>
                  Detach
                </Button>
              </>
            )}
          </div>
        )}
        <MoveAlertDialog
          open={moving !== null}
          onOpenChange={(o) => setMoving(o ? moving : null)}
          alert={a}
          detachOnly={moving === "detach"}
        />
      </div>
  );
}
