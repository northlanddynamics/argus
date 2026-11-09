import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { Time } from "@/components/time";
import { type FormEvent, type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { ChevronRight } from "lucide-react";
import { ago, FALCON_CLOUDS, type FalconCloud, falconCloudLabel, healthWord, type IntegrationView, integrationsKey, integrationsQuery } from "@/lib/alerts";
import { api, errorMessage } from "@/lib/api";
import { useLiveStatus } from "@/lib/live";
import { type Provider, providerLabel } from "api/integrations/vocabulary";
import { SEVERITIES, type Severity, severityLabel } from "api/cases/vocabulary";
import { Checkbox } from "@/components/ui/checkbox";
import { FALCON_IOC_PLATFORMS, type FalconIocDefaults, type FalconIocPlatform, falconIocPlatformLabel } from "@/lib/response-actions";

/** The Amber Notice treatment (DESIGN.md): the one warning style. */
const notice = "border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80";

/** Throws the API's error message unless `res` is OK. */
async function ok(res: Response, fallback: string) {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
}

/** "in 18 min", or "due" once it has passed. */
const until = (iso: string) => {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  return minutes <= 0 ? "due" : `in ${minutes} min`;
};

/** Settings · Integrations: the Organization's CrowdStrike, Mimecast, Cisco Umbrella and IPinfo Integrations and how they are doing. */
export function IntegrationsPage() {
  const integrations = useQuery(integrationsQuery);
  // Health and the last event refresh live.
  useLiveStatus();
  return (
    <>
      <PageHeader
        title="Integrations"
        actions={
          <>
            {/* IPs are looked up through one IPinfo Integration (ADR 0010). */}
            {integrations.data && !integrations.data.some((i) => i.provider === "ipinfo") && <AddIntegrationDialog provider="ipinfo" />}
            <AddIntegrationDialog provider="umbrella" />
            <AddIntegrationDialog provider="mimecast" />
            <AddIntegrationDialog provider="crowdstrike" />
          </>
        }
      />
      {integrations.isPending && <Skeleton className="h-48 w-full rounded-xl" />}
      {integrations.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn't load the Integrations. Nothing about them has changed.</span>
            <Button variant="outline" size="sm" onClick={() => void integrations.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {integrations.data?.map((i) => <IntegrationCard key={i.id} integration={i} />)}
      {integrations.data?.length === 0 && (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No Integrations yet. Add a CrowdStrike Integration to receive Falcon detections as Alerts, a Mimecast Integration to block
            email senders, Cisco Umbrella to check and add domains to its destination lists, or IPinfo to see where IP addresses are and
            who runs them.
          </CardContent>
        </Card>
      )}
      <TeamsChannelCard />
    </>
  );
}

const teamsChannelKey = ["teams-channel"] as const;

/** The Organization's Teams channel: its incoming webhook, a test post, and what is posted to it. */
function TeamsChannelCard() {
  const queryClient = useQueryClient();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [tested, setTested] = useState(false);
  const channel = useQuery({
    queryKey: teamsChannelKey,
    queryFn: async () => {
      const res = await api["teams-channel"].$get();
      if (!res.ok) throw new Error(await errorMessage(res, "Could not load the Teams channel"));
      return (await res.json()).teamsChannel;
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: teamsChannelKey });
  const save = useMutation({
    mutationFn: async () => ok(await api["teams-channel"].$put({ json: { webhookUrl } }), "Could not save the webhook"),
    onSuccess: async () => {
      setWebhookUrl("");
      setTested(false);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async () => ok(await api["teams-channel"].$delete(), "Could not remove the webhook"),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: async () => ok(await api["teams-channel"].test.$post({ json: webhookUrl ? { webhookUrl } : {} }), "Could not send a test post"),
    onMutate: () => setTested(false),
    onSuccess: () => setTested(true),
  });
  const configured = channel.data?.configured ?? false;
  const error = save.error ?? remove.error ?? test.error;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <Card id="teams" data-testid="teams-channel">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3 self-center">
          <CardTitle>Teams channel</CardTitle>
          <Badge variant={configured ? "default" : "outline"}>{configured ? "Active" : "Not set"}</Badge>
        </div>
        {configured && (
          <CardAction>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={remove.isPending}>
                  Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Stop posting to the Teams channel?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Argus forgets the incoming webhook, so new Critical Cases and Cases opened from Alerts are no longer posted. What was already
                    posted stays in Teams. You can add a webhook again at any time.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
                    Remove webhook
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {channel.isError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{channel.error.message}</AlertDescription>
          </Alert>
        )}
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="teams-webhook">{configured ? "Replace the incoming webhook URL" : "Incoming webhook URL"}</Label>
            <Input
              id="teams-webhook"
              type="url"
              autoComplete="off"
              placeholder="https://….webhook.office.com/… or a Teams Workflows URL"
              value={webhookUrl}
              onChange={(e) => {
                setWebhookUrl(e.target.value);
                setTested(false);
              }}
            />
            {channel.data?.webhook && (
              <p className="text-sm text-muted-foreground">
                In use: <span className="font-mono">{channel.data.webhook.hint}</span>, set by {channel.data.webhook.updatedBy.name} on{" "}
                {new Date(channel.data.webhook.updatedAt).toLocaleDateString()}
              </p>
            )}
          </div>
          <div className="grid gap-1 text-sm">
            <span className="font-semibold">Posts to the channel when</span>
            <ul className="list-disc pl-5">
              <li>a new Case is opened as Critical</li>
              <li>a Case's Severity is raised to Critical</li>
              <li>a Case is opened from Alerts</li>
            </ul>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
          {tested && !error && (
            <Alert>
              <AlertDescription>Test post sent. Check the channel.</AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={test.isPending || (!webhookUrl && !configured)} onClick={() => test.mutate()}>
              Send test post
            </Button>
            <Button type="submit" disabled={save.isPending || !webhookUrl}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function IntegrationCard({ integration: i }: { integration: IntegrationView }) {
  const queryClient = useQueryClient();
  const setPaused = useMutation({
    mutationFn: async (paused: boolean) => {
      const param = { id: i.id };
      const res = paused ? await api.integrations[":id"].pause.$post({ param }) : await api.integrations[":id"].resume.$post({ param });
      await ok(res, paused ? "Could not pause the Integration" : "Could not resume the Integration");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const setWriteBack = useMutation({
    mutationFn: async (enabled: boolean) =>
      ok(await api.integrations[":id"]["write-back"].$put({ param: { id: i.id }, json: { enabled } }), "Could not change write-back"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const setResponseActions = useMutation({
    mutationFn: async (enabled: boolean) =>
      ok(await api.integrations[":id"]["response-actions"].$put({ param: { id: i.id }, json: { enabled } }), "Could not change Response Actions"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const setHostContainment = useMutation({
    mutationFn: async (enabled: boolean) =>
      ok(await api.integrations[":id"]["host-containment"].$put({ param: { id: i.id }, json: { enabled } }), "Could not change Host containment"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const remove = useMutation({
    mutationFn: async () => ok(await api.integrations[":id"].$delete({ param: { id: i.id } }), "Could not delete the Integration"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const { receivesAlerts, writesBack, responseActions } = i.capabilities;
  const word = healthWord(i);
  return (
    <Card data-testid={`integration-${i.name}`}>
      <CardHeader className="border-b">
        <div className="flex items-center gap-3 self-center">
          <CardTitle>{i.name}</CardTitle>
          <Badge variant={word === "Connected" ? "default" : "outline"} className={word === "Error" ? "border-destructive text-destructive" : undefined}>
            {word}
          </Badge>
          {writesBack && !i.writeBack && <Badge variant="outline">Alert write-back off</Badge>}
        </div>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="sm" disabled={setPaused.isPending} onClick={() => setPaused.mutate(!i.paused)}>
            {i.paused ? "Resume" : "Pause"}
          </Button>
          <RotateCredentialsDialog integration={i} />
          <DeleteIntegrationDialog integration={i} onDelete={() => remove.mutate()} pending={remove.isPending} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {receivesAlerts && <StreamSummary integration={i} />}
        {!receivesAlerts && !i.paused && (
          <p className="text-sm text-muted-foreground">
            {i.capabilities.looksUpIps
              ? i.healthCheckedAt
                ? `Token last used ${ago(i.healthCheckedAt)}`
                : "Checking the token…"
              : i.healthCheckedAt
                ? `Credentials checked ${ago(i.healthCheckedAt)}`
                : "Checking the credentials…"}
          </p>
        )}
        {i.healthDetail && !i.paused && (
          <Alert variant={i.health === "error" ? "destructive" : "default"}>
            <AlertDescription>{i.healthDetail}</AlertDescription>
          </Alert>
        )}
        {i.hostEnrichmentError && !i.paused && (
          <Alert>
            <AlertDescription>{i.hostEnrichmentError}. Grant it to the API client to see hosts' Enrichment; nothing else is affected.</AlertDescription>
          </Alert>
        )}
        {i.identityEnrichmentError && !i.paused && (
          <Alert>
            <AlertDescription>{i.identityEnrichmentError}. Grant it to see accounts' Enrichment; nothing else is affected.</AlertDescription>
          </Alert>
        )}
        {i.lastGap && (
          <Alert className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
            <AlertTitle>Gap in the stream, noticed {new Date(i.lastGap.at).toLocaleString()}</AlertTitle>
            <AlertDescription>
              Falcon could no longer replay events {i.lastGap.fromOffset.toLocaleString()}–{i.lastGap.toOffset.toLocaleString()}, so
              Alerts raised then may be missing.
            </AlertDescription>
          </Alert>
        )}
        {setPaused.error && (
          <Alert variant="destructive">
            <AlertDescription>{setPaused.error.message}</AlertDescription>
          </Alert>
        )}
        {remove.error && (
          <Alert variant="destructive">
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        {writesBack && (
          <ConfirmOn
            title={`Write Alert changes back to ${i.name}?`}
            body={
              <>
                From now on, changing an Alert's Status or Assignee, commenting on it or closing its Case is sent to CrowdStrike, where your
                Falcon console shows it. The API client needs Alerts write scope; without it, write-backs fail and show here.
              </>
            }
            confirm="Turn on write-back"
            onConfirm={() => setWriteBack.mutate(true)}
          >
            {(ask) => (
              <WriteBackSetting
                id={`write-back-${i.id}`}
                checked={setWriteBack.isPending ? setWriteBack.variables : i.writeBack}
                // Only Admins (who see the credentials) may change it.
                disabled={!i.credentials || setWriteBack.isPending}
                lockedReason={!i.credentials ? "Only Admins can change this." : undefined}
                onCheckedChange={(enabled) => (enabled ? ask() : setWriteBack.mutate(false))}
              />
            )}
          </ConfirmOn>
        )}
        {setWriteBack.error && (
          <Alert variant="destructive">
            <AlertDescription>{setWriteBack.error.message}</AlertDescription>
          </Alert>
        )}
        {responseActions && (
          <ConfirmOn
            title={`Allow Response Actions through ${i.name}?`}
            body={
              i.provider === "crowdstrike" ? (
                <>The API client needs IOC Management write scope; without it, sends fail on the Case with a 403.</>
              ) : i.provider === "umbrella" ? (
                <>
                  Members can then add domains linked to a Case to the destination list chosen below. The API key needs the Policies ·
                  Destination Lists write scope; without it, adds fail on the Case.
                </>
              ) : (
                <>The API application's role needs Gateway · Policies · Edit; without it, blocks fail on the Case.</>
              )
            }
            confirm="Allow Response Actions"
            onConfirm={() => setResponseActions.mutate(true)}
          >
            {(ask) => (
              <ResponseActionsSetting
                id={`response-actions-${i.id}`}
                provider={i.provider}
                checked={setResponseActions.isPending ? setResponseActions.variables : i.responseActions}
                disabled={!i.credentials || setResponseActions.isPending}
                lockedReason={!i.credentials ? "Only Admins can change this." : undefined}
                onCheckedChange={(enabled) => (enabled ? ask() : setResponseActions.mutate(false))}
              />
            )}
          </ConfirmOn>
        )}
        {setResponseActions.error && (
          <Alert variant="destructive">
            <AlertDescription>{setResponseActions.error.message}</AlertDescription>
          </Alert>
        )}
        {i.provider === "crowdstrike" && (
          <ConfirmOn
            title={`Allow containing hosts through ${i.name}?`}
            body={
              <>
                Any Member who can work a Case can then contain a host linked to it, cutting it off from the network except for Falcon. Each
                containment is confirmed with the host's details first. The API client needs Hosts: Write; without it, containment fails on
                the Case.
              </>
            }
            confirm="Allow Host containment"
            onConfirm={() => setHostContainment.mutate(true)}
          >
            {(ask) => (
              <HostContainmentSetting
                id={`host-containment-${i.id}`}
                checked={setHostContainment.isPending ? setHostContainment.variables : i.hostContainment}
                disabled={!i.credentials || setHostContainment.isPending}
                lockedReason={!i.credentials ? "Only Admins can change this." : undefined}
                onCheckedChange={(enabled) => (enabled ? ask() : setHostContainment.mutate(false))}
              />
            )}
          </ConfirmOn>
        )}
        {setHostContainment.error && (
          <Alert variant="destructive">
            <AlertDescription>{setHostContainment.error.message}</AlertDescription>
          </Alert>
        )}
        {i.provider === "umbrella" && <DestinationListSetting integration={i} />}
        {receivesAlerts && (
          // Keyed by what is saved, so a change saved elsewhere replaces the form's.
          <IgnoredSeverities key={i.ignoredSeverities.join()} integration={i} />
        )}
        {responseActions && (
          // Keyed by what is saved, so a change saved elsewhere replaces the form's.
          <ResponseActionDefaults key={JSON.stringify(i.responseActionDefaults)} integration={i} />
        )}
        {writesBack && <WriteBacks counts={i.writeBacks} />}
        {responseActions && (i.responseActions || hasAny(i.responseActionCounts)) && (
          <ResponseActionCounts counts={i.responseActionCounts} />
        )}
        {i.credentials && i.provider === "ipinfo" && (
          <p className="text-sm text-muted-foreground">
            IPinfo API token <span className="font-mono">{i.credentials.clientIdHint}</span> · set {new Date(i.credentials.updatedAt).toLocaleDateString()}
          </p>
        )}
        {i.credentials && i.provider !== "ipinfo" && (
          <p className="text-sm text-muted-foreground">
            {i.provider === "crowdstrike" && i.cloud
              ? `Falcon API credentials: ${falconCloudLabel[i.cloud]} cloud`
              : i.provider === "umbrella"
                ? "Umbrella API"
                : `${providerLabel[i.provider]} API 2.0 credentials`}{" "}
            · {i.provider === "umbrella" ? "key" : "client"} <span className="font-mono">{i.credentials.clientIdHint}</span> · set{" "}
            {new Date(i.credentials.updatedAt).toLocaleDateString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The Integration's write-backs to Falcon by where they stand; sent, skipped and failed over the last 24 hours. */
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Deleting an Integration (ADR 0013), confirmed first: it stops for good and leaves this page, but
 * what came in or was done through it stays where it is.
 */
function DeleteIntegrationDialog({ integration: i, onDelete, pending }: { integration: IntegrationView; onDelete: () => void; pending: boolean }) {
  const { receivesAlerts, responseActions, looksUpIps } = i.capabilities;
  const kept = [
    receivesAlerts && "the Alerts it brought in",
    responseActions && "the Response Actions taken through it",
    looksUpIps && "the IP details already looked up",
  ].filter((k): k is string => Boolean(k));
  const stops = receivesAlerts
    ? "Argus stops reading its Alert stream and writing back to it."
    : looksUpIps
      ? "Argus stops looking IPs up through it."
      : "Argus stops taking Response Actions through it.";
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {i.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {stops} {kept.length > 0 && `${capitalized(kept.join(" and "))} stay, under its name. `}It can't be resumed: to connect again, add a
            new Integration.{responseActions && " Any Response Actions taken through it that are still in place must be removed from their Cases first."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>
            Delete Integration
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function WriteBacks({ counts: w }: { counts: IntegrationView["writeBacks"] }) {
  return (
    <div className="grid gap-2" data-testid="write-backs">
      <span className="text-sm font-semibold">Write-backs to Falcon</span>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">Pending {w.pending}</Badge>
        <Badge variant="outline" className={w.retrying ? "border-notice-border text-notice-foreground" : undefined}>
          Retrying {w.retrying}
          {w.nextRetryAt ? ` · next ${until(w.nextRetryAt)}` : ""}
        </Badge>
        <Badge variant="outline">Sent (24 h) {w.sent}</Badge>
        <Badge variant="outline">Skipped, no Falcon user match (24 h) {w.skipped}</Badge>
        {w.failed > 0 && (
          <Badge variant="outline" className="border-destructive text-destructive">
            Failed (24 h) {w.failed}
          </Badge>
        )}
      </div>
      {w.lastError && <p className="text-sm text-muted-foreground">Last failure: {w.lastError}</p>}
    </div>
  );
}

const hasAny = (c: IntegrationView["responseActionCounts"]) => c.pending + c.active + c.failed > 0;

/** What Argus holds in the tool through this Integration, and what is waiting or failed. */
function ResponseActionCounts({ counts: c }: { counts: IntegrationView["responseActionCounts"] }) {
  return (
    <div className="grid gap-2" data-testid="response-action-counts">
      <span className="text-sm font-semibold">Response Actions through this Integration</span>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">Active {c.active}</Badge>
        <Badge variant="outline">Pending {c.pending}</Badge>
        {c.failed > 0 && (
          <Badge variant="outline" className="border-destructive text-destructive">
            Failed {c.failed}
          </Badge>
        )}
      </div>
      {c.lastError && <p className="text-sm text-muted-foreground">Last failure: {c.lastError}</p>}
    </div>
  );
}

/** The stream at a glance (its last event), with the worker's bookkeeping folded away. */
function StreamSummary({ integration: i }: { integration: IntegrationView }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span className="text-muted-foreground">Last event </span>
          {i.lastEventAt ? <Time iso={i.lastEventAt} className="font-medium" /> : <span className="font-medium">None yet</span>}
        </span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="xs" className="text-muted-foreground">
            <ChevronRight className={open ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden />
            Stream details
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Session refresh</dt>
          <dd>{i.sessionRefreshAt ? until(i.sessionRefreshAt) : "—"}</dd>
          <dt className="text-muted-foreground">Stream offset</dt>
          <dd className="font-mono tabular-nums">{i.streamOffset === null ? "—" : i.streamOffset.toLocaleString()}</dd>
          <dt className="text-muted-foreground">Worker</dt>
          <dd className="font-mono">{i.workerId ?? "—"}</dd>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Asks before a switch turns something on that reaches outside Argus; turning it off needs no
 * asking. `children` gets `ask`, which opens the confirmation.
 */
function ConfirmOn({
  title,
  body,
  confirm,
  onConfirm,
  children,
}: {
  title: string;
  body: ReactNode;
  confirm: string;
  onConfirm: () => void;
  children: (ask: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children(() => setOpen(true))}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <Alert className={notice}>
                  <AlertDescription>{body}</AlertDescription>
                </Alert>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>{confirm}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The write-back switch: on, Argus writes Alert changes back to Falcon; off, it only reads. */
function WriteBackSetting(props: {
  id: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  name?: string;
  /** Why it can't be changed, said under it. */
  lockedReason?: string;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const { id, lockedReason, ...rest } = props;
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} className="mt-0.5" {...rest} />
      <div className="grid gap-1">
        <Label htmlFor={id}>Write back to Falcon</Label>
        <p className="text-sm text-muted-foreground">
          Send Alert Status, Assignee, comments and Case closure to CrowdStrike.
          {lockedReason && ` ${lockedReason}`}
        </p>
      </div>
    </div>
  );
}

/** The Host containment switch: on, Members may contain hosts through the CrowdStrike Integration from a Case (ADR 0009). */
function HostContainmentSetting(props: {
  id: string;
  checked?: boolean;
  disabled?: boolean;
  /** Why it can't be changed, said under it. */
  lockedReason?: string;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const { id, lockedReason, ...rest } = props;
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} className="mt-0.5" {...rest} />
      <div className="grid gap-1">
        <Label htmlFor={id}>Host containment</Label>
        <p className="text-sm text-muted-foreground">
          Contain hosts in Falcon from a Case. Separate from Response Actions; the API client needs Hosts: Write.
          {lockedReason && ` ${lockedReason}`}
        </p>
      </div>
    </div>
  );
}

/**
 * The destination list a Cisco Umbrella Integration adds domains to (ADR 0014). Every Member sees
 * which; Admins choose it from Umbrella's lists, read when they open the chooser.
 */
function DestinationListSetting({ integration: i }: { integration: IntegrationView }) {
  const queryClient = useQueryClient();
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<string>("");
  const locked = !i.credentials;
  const lists = useQuery({
    queryKey: [...integrationsKey, i.id, "destination-lists"],
    enabled: choosing,
    queryFn: async () => {
      const res = await api.integrations[":id"]["destination-lists"].$get({ param: { id: i.id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not read Umbrella's destination lists"));
      const body = await res.json();
      if (!("destinationLists" in body)) throw new Error("Unexpected response");
      return body.destinationLists;
    },
  });
  const save = useMutation({
    mutationFn: async (destinationListId: number) =>
      ok(await api.integrations[":id"]["destination-list"].$put({ param: { id: i.id }, json: { destinationListId } }), "Could not choose the destination list"),
    onSuccess: () => setChoosing(false),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const current = i.destinationList;
  return (
    <div className="grid gap-2 rounded-lg border p-3" data-testid="destination-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="text-sm font-semibold">Destination list</span>
          <p className="text-sm text-muted-foreground">
            {current ? (
              <>
                Domains are added to <span className="font-medium text-foreground">{current.name}</span> ({current.access === "block" ? "Block" : "Allow"}
                ).
              </>
            ) : (
              "None chosen yet: Members can't add domains to Umbrella until an Admin chooses one."
            )}
            {locked && " Only Admins can change this."}
          </p>
        </div>
        {!locked && !choosing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPicked(current ? String(current.id) : "");
              save.reset();
              setChoosing(true);
            }}
          >
            {current ? "Change" : "Choose list"}
          </Button>
        )}
      </div>
      {choosing && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (picked) save.mutate(Number(picked));
          }}
        >
          {lists.isPending && <Skeleton className="h-9 w-64" />}
          {lists.data && (
            <div className="grid min-w-64 gap-1">
              <Label htmlFor={`destination-list-${i.id}`}>Umbrella destination list</Label>
              <NativeSelect id={`destination-list-${i.id}`} value={picked} onChange={(e) => setPicked(e.target.value)}>
                <NativeSelectOption value="" disabled>
                  Choose a list…
                </NativeSelectOption>
                {lists.data.map((l) => (
                  <NativeSelectOption key={l.id} value={String(l.id)}>
                    {l.name} · {l.access === "block" ? "Block" : "Allow"}
                    {l.isGlobal ? " · global" : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {lists.data?.length === 0 && <p className="text-sm text-muted-foreground">Umbrella has no destination lists yet.</p>}
          <Button type="submit" size="sm" disabled={!picked || save.isPending}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setChoosing(false)}>
            Cancel
          </Button>
        </form>
      )}
      {(lists.error ?? save.error) && (
        <Alert variant="destructive">
          <AlertDescription>{(lists.error ?? save.error)!.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** The Response Actions switch: on, Members may take Response Actions through the Integration from a Case. */
function ResponseActionsSetting(props: {
  id: string;
  provider: Provider;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  name?: string;
  /** Why it can't be changed, said under it. */
  lockedReason?: string;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const { id, provider, lockedReason, ...rest } = props;
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} className="mt-0.5" {...rest} />
      <div className="grid gap-1">
        <Label htmlFor={id}>Response Actions</Label>
        <p className="text-sm text-muted-foreground">
          {provider === "crowdstrike"
            ? "Add custom IOCs to Falcon. The API client needs IOC Management write scope."
            : provider === "umbrella"
              ? "Add domains to a destination list in Cisco Umbrella."
              : `Block email senders and domains in ${providerLabel[provider]}.`}
          {lockedReason && ` ${lockedReason}`}
        </p>
      </div>
    </div>
  );
}

/**
 * The Severities of detections the Integration receives no Alert for: a detection of one of them is
 * skipped as it arrives, and leaves an Alert already received as it was. Admins change them; every
 * Member sees them. At least one Severity stays unignored: pausing is how to stop Alerts altogether.
 */
function IgnoredSeverities({ integration: i }: { integration: IntegrationView }) {
  const queryClient = useQueryClient();
  const saved = i.ignoredSeverities;
  const [draft, setDraft] = useState<Severity[]>(saved);
  const locked = !i.credentials;
  const save = useMutation({
    mutationFn: async (severities: Severity[]) =>
      ok(await api.integrations[":id"]["ignored-severities"].$put({ param: { id: i.id }, json: { severities } }), "Could not save the ignored Severities"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const changed = SEVERITIES.some((s) => draft.includes(s) !== saved.includes(s));
  const all = draft.length === SEVERITIES.length;
  const toggle = (severity: Severity, on: boolean) => setDraft((d) => SEVERITIES.filter((s) => (s === severity ? on : d.includes(s))));
  const id = (severity: Severity) => `ignored-severity-${severity}-${i.id}`;
  return (
    <form
      className="grid gap-3 rounded-lg border p-3"
      aria-label="Ignored Severities"
      data-testid="ignored-severities"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !all) save.mutate(draft);
      }}
    >
      <div className="grid gap-0.5">
        <span className="text-sm font-semibold">Ignored Severities</span>
        <p className="text-sm text-muted-foreground">
          Detections of these Severities are skipped and don't become Alerts. Alerts already received are kept.
          {locked && " Only Admins can change these."}
        </p>
      </div>
      <div className="flex flex-wrap gap-4" role="group" aria-label="Severities to ignore">
        {SEVERITIES.map((s) => (
          <div key={s} className="flex items-center gap-2">
            <Checkbox id={id(s)} checked={draft.includes(s)} disabled={locked} onCheckedChange={(checked) => toggle(s, checked === true)} />
            <Label htmlFor={id(s)} className="font-normal">
              {severityLabel[s]}
            </Label>
          </div>
        ))}
      </div>
      {all && <p className="text-xs text-destructive">Leave at least one Severity unignored. To stop receiving Alerts, pause the Integration.</p>}
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      {!locked && (
        <div className="flex justify-end gap-2">
          {changed && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(saved)}>
              Reset
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!changed || all || save.isPending}>
            Save ignored Severities
          </Button>
        </div>
      )}
    </form>
  );
}

/**
 * What a custom IOC taken through the Integration is sent with besides alert or block: Falcon needs a
 * severity and platforms, so a Member can take one in a single click (ADR 0008). Admins change them;
 * every Member sees them. Response Actions already taken keep what they were taken with. Only whether
 * they start Internal applies to a Mimecast Integration.
 */
function ResponseActionDefaults({ integration: i }: { integration: IntegrationView }) {
  const queryClient = useQueryClient();
  const saved = i.responseActionDefaults;
  const [draft, setDraft] = useState<FalconIocDefaults>(saved);
  const locked = !i.credentials;
  const save = useMutation({
    mutationFn: async (next: FalconIocDefaults) =>
      ok(await api.integrations[":id"]["response-action-defaults"].$put({ param: { id: i.id }, json: next }), "Could not save the defaults"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const changed =
    draft.severity !== saved.severity ||
    draft.internal !== saved.internal ||
    FALCON_IOC_PLATFORMS.some((p) => draft.platforms.includes(p) !== saved.platforms.includes(p));
  const togglePlatform = (p: FalconIocPlatform, on: boolean) =>
    setDraft((d) => ({ ...d, platforms: FALCON_IOC_PLATFORMS.filter((x) => (x === p ? on : d.platforms.includes(x))) }));
  const id = (field: string) => `ioc-defaults-${field}-${i.id}`;
  const falcon = i.provider === "crowdstrike";
  return (
    <form
      className="grid gap-3 rounded-lg border p-3"
      aria-label="Response Action defaults"
      data-testid="response-action-defaults"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && draft.platforms.length) save.mutate(draft);
      }}
    >
      <div className="grid gap-0.5">
        <span className="text-sm font-semibold">{falcon ? "IOC defaults" : i.provider === "umbrella" ? "Destination list defaults" : "Block defaults"}</span>
        {locked && <p className="text-sm text-muted-foreground">Only Admins can change these.</p>}
      </div>
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center">
        {falcon && (
          <>
            <Label htmlFor={id("severity")}>Severity</Label>
            <NativeSelect
              id={id("severity")}
              value={draft.severity}
              disabled={locked}
              onChange={(e) => setDraft((d) => ({ ...d, severity: e.target.value as FalconIocDefaults["severity"] }))}
            >
              <NativeSelectOption value="case">The Case's Severity</NativeSelectOption>
              {SEVERITIES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {severityLabel[s]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span className="text-sm font-medium">Platforms</span>
            <div className="flex flex-wrap gap-4" role="group" aria-label="Platforms">
              {FALCON_IOC_PLATFORMS.map((p) => (
                <div key={p} className="flex items-center gap-2">
                  <Checkbox
                    id={id(p)}
                    checked={draft.platforms.includes(p)}
                    disabled={locked}
                    onCheckedChange={(checked) => togglePlatform(p, checked === true)}
                  />
                  <Label htmlFor={id(p)} className="font-normal">
                    {falconIocPlatformLabel[p]}
                  </Label>
                </div>
              ))}
            </div>
          </>
        )}
        <span className="text-sm font-medium">Visibility</span>
        <div className="flex items-center gap-2">
          <Checkbox
            id={id("internal")}
            checked={draft.internal}
            disabled={locked}
            onCheckedChange={(checked) => setDraft((d) => ({ ...d, internal: checked === true }))}
          />
          <Label htmlFor={id("internal")} className="font-normal">
            Internal
          </Label>
        </div>
      </div>
      {draft.platforms.length === 0 && <p className="text-xs text-destructive">Choose at least one platform.</p>}
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      {!locked && (
        <div className="flex justify-end gap-2">
          {changed && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(saved)}>
              Reset
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!changed || !draft.platforms.length || save.isPending}>
            Save defaults
          </Button>
        </div>
      )}
    </form>
  );
}

function CredentialFields({ provider = "crowdstrike" }: { provider?: Provider }) {
  if (provider === "ipinfo") {
    return (
      <div className="grid gap-2">
        <Label htmlFor="ipinfo-token">API access token</Label>
        <Input id="ipinfo-token" name="token" type="password" required minLength={8} autoComplete="new-password" />
      </div>
    );
  }
  const app = provider === "crowdstrike" ? "API client" : provider === "umbrella" ? "API key" : "API application client";
  if (provider === "umbrella") {
    return (
      <>
        <div className="grid gap-2">
          <Label htmlFor="falcon-client-id">{app}</Label>
          <Input id="falcon-client-id" name="clientId" required autoComplete="off" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="falcon-client-secret">Key secret</Label>
          <Input id="falcon-client-secret" name="clientSecret" type="password" required autoComplete="new-password" />
        </div>
      </>
    );
  }
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="falcon-client-id">{app} ID</Label>
        <Input id="falcon-client-id" name="clientId" required autoComplete="off" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="falcon-client-secret">{app} secret</Label>
        <Input id="falcon-client-secret" name="clientSecret" type="password" required autoComplete="new-password" />
      </div>
    </>
  );
}

const credentialsFrom = (form: FormData) => ({ clientId: String(form.get("clientId")), clientSecret: String(form.get("clientSecret")) });
const tokenFrom = (form: FormData) => ({ token: String(form.get("token")) });

/**
 * Adds a CrowdStrike Integration, a Mimecast or Cisco Umbrella one, which have no cloud, Alert stream
 * or write-back, or the IPinfo one, which only looks IPs up (ADR 0010).
 */
function AddIntegrationDialog({ provider }: { provider: Provider }) {
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const falcon = provider === "crowdstrike";
  const add = useMutation({
    mutationFn: async (
      json:
        | { provider: "crowdstrike"; name: string; cloud: FalconCloud; clientId: string; clientSecret: string; writeBack: boolean; responseActions: boolean }
        | { provider: "mimecast" | "umbrella"; name: string; clientId: string; clientSecret: string; responseActions: boolean }
        | { provider: "ipinfo"; name: string; token: string },
    ) => ok(await api.integrations.$post({ json }), "Could not add the Integration"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      setIsOpen(false);
    },
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (provider === "ipinfo") return add.mutate({ provider, name: String(form.get("name")), ...tokenFrom(form) });
    const common = { name: String(form.get("name")), responseActions: form.get("responseActions") === "on", ...credentialsFrom(form) };
    add.mutate(
      falcon
        ? { provider, ...common, cloud: form.get("cloud") as FalconCloud, writeBack: form.get("writeBack") === "on" }
        : { provider: provider === "umbrella" ? "umbrella" : "mimecast", ...common },
    );
  };
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) add.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant={falcon ? "default" : "outline"}>+ Add {providerLabel[provider]} Integration</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a {providerLabel[provider]} Integration</DialogTitle>
          {provider === "ipinfo" && (
            <DialogDescription>
              Copy the API access token from your IPinfo account. Argus uses the Core API: location, network, and the anonymous, hosting,
              anycast, mobile and satellite flags.
            </DialogDescription>
          )}
          {provider === "umbrella" && (
            <DialogDescription>
              Create an API key in the Umbrella dashboard (Admin · API Keys) with the Policies · Destination Lists scope, read and write. Once
              it is added, choose the destination list Argus adds domains to.
            </DialogDescription>
          )}
          {provider === "mimecast" && (
            <DialogDescription>
              Create an API 2.0 application in the Mimecast Administration Console whose role has Gateway · Policies · Edit.
            </DialogDescription>
          )}
          {falcon && (
            <>
              <DialogDescription>Create an API client in the Falcon console with these scopes:</DialogDescription>
              <ul className="grid gap-1 text-sm">
                <li>
                  <span className="font-medium">Event Streams: Read</span>
                </li>
                <li>
                  <span className="font-medium">Alerts: Write</span>
                  <span className="text-muted-foreground"> — for write-back</span>
                </li>
                <li>
                  <span className="font-medium">IOC Management: Write</span>
                  <span className="text-muted-foreground"> — for Response Actions</span>
                </li>
              </ul>
            </>
          )}
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className={falcon ? "grid gap-4 sm:grid-cols-[1fr_auto]" : "grid gap-4"}>
            <div className="grid gap-2">
              <Label htmlFor="integration-name">Name</Label>
              <Input
                id="integration-name"
                name="name"
                required
                maxLength={80}
                placeholder={falcon ? "CrowdStrike — Prod" : providerLabel[provider]}
                defaultValue={provider === "ipinfo" ? "IPinfo" : undefined}
              />
            </div>
            {falcon && (
              <div className="grid gap-2">
                <Label htmlFor="integration-cloud">Falcon cloud</Label>
                <NativeSelect id="integration-cloud" name="cloud" defaultValue="us-1">
                  {FALCON_CLOUDS.map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {falconCloudLabel[c]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            )}
          </div>
          <CredentialFields provider={provider} />
          {falcon && <WriteBackSetting id="integration-write-back" name="writeBack" defaultChecked={false} />}
          {provider !== "ipinfo" && (
            <ResponseActionsSetting id="integration-response-actions" provider={provider} name="responseActions" defaultChecked={false} />
          )}
          {add.error && (
            <Alert variant="destructive">
              <AlertDescription>{add.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={add.isPending}>
              Add Integration
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateCredentialsDialog({ integration }: { integration: IntegrationView }) {
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const rotate = useMutation({
    mutationFn: async (json: { clientId: string; clientSecret: string } | { token: string }) =>
      ok(await api.integrations[":id"].credentials.$put({ param: { id: integration.id }, json }), "Could not rotate the credentials"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      setIsOpen(false);
    },
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    rotate.mutate(integration.provider === "ipinfo" ? tokenFrom(form) : credentialsFrom(form));
  };
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) rotate.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {integration.provider === "ipinfo" ? "Rotate token" : "Rotate credentials"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Rotate {integration.provider === "ipinfo" ? "the token" : "credentials"} of {integration.name}
          </DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <CredentialFields provider={integration.provider} />
          {rotate.error && (
            <Alert variant="destructive">
              <AlertDescription>{rotate.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={rotate.isPending}>
              Rotate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
