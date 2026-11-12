import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { Time } from "@/components/time";
import { type FormEvent, type ReactNode, useId, useState } from "react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { ago, FALCON_CLOUDS, type FalconCloud, falconCloudLabel, healthWord, type IntegrationView, integrationsKey, integrationsQuery } from "@/lib/alerts";
import { api, errorMessage } from "@/lib/api";
import { useLiveStatus } from "@/lib/live";
import { FALCON_CONSOLES } from "api/alerts/vocabulary";
import { type Provider, providerLabel } from "api/integrations/vocabulary";
import { SEVERITIES, type Severity, severityLabel } from "api/cases/vocabulary";
import { Checkbox } from "@/components/ui/checkbox";
import { FALCON_IOC_PLATFORMS, type FalconIocDefaults, type FalconIocPlatform, falconIocPlatformLabel } from "@/lib/response-actions";

/** The Amber Notice treatment (DESIGN.md): the one warning style. */

/** A section of an Integration's card, set off from the one above by a hairline. */
const section = "grid gap-2 border-t pt-4";
/** A section's heading, under the card's `h2`. */
const sectionHeading = "text-sm font-semibold";

/**
 * The Falcon API scopes Argus can use, each with what it is for. The Add dialog lists them all and
 * each switch names its own, so an Admin grants them once, up front.
 */
const FALCON_SCOPE = {
  stream: "Event Streams: Read",
  hosts: "Hosts: Read",
  identities: "Identity Protection Entities: Read",
  writeBack: "Alerts: Write",
  iocs: "IOC Management: Write",
  containment: "Hosts: Write",
  workflows: "Workflow: Read and Workflow: Write",
} as const;

const FALCON_SCOPES: { scope: string; use: string; required?: boolean }[] = [
  { scope: FALCON_SCOPE.stream, use: "receiving detections as Alerts", required: true },
  { scope: FALCON_SCOPE.hosts, use: "hosts' Enrichment" },
  { scope: FALCON_SCOPE.identities, use: "accounts' Enrichment" },
  { scope: FALCON_SCOPE.writeBack, use: "Write back to Falcon" },
  { scope: FALCON_SCOPE.iocs, use: "Response Actions (custom IOCs)" },
  { scope: FALCON_SCOPE.containment, use: "Host containment" },
  { scope: FALCON_SCOPE.workflows, use: "Workflows" },
];

/** Throws the API's error message unless `res` is OK. */
async function ok(res: Response, fallback: string) {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
}

/** "in 18 min", or "due" once it has passed. */
const until = (iso: string) => {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  return minutes <= 0 ? "due" : `in ${minutes} min`;
};

/** "Low", "Low and Informational", "Medium, Low and Informational". */
const listed = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** "1 Alert change", "3 Alert changes". */
const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What each Provider is for, said in the Add menu. */
const providerUse: Record<Provider, string> = {
  crowdstrike: "Falcon detections arrive as Alerts",
  mimecast: "Block email senders and domains",
  umbrella: "Check domains and add them to destination lists",
  ipinfo: "See where IP addresses are and who runs them",
};

/** Settings · Integrations: the Organization's CrowdStrike, Mimecast, Cisco Umbrella and IPinfo Integrations and how they are doing. */
export function IntegrationsPage() {
  const integrations = useQuery(integrationsQuery);
  // Health and the last event refresh live.
  useLiveStatus();
  // One Add dialog, opened from the menu or the empty state. The Provider outlives `open`, so it stays put while the dialog closes.
  const [adding, setAdding] = useState<{ provider: Provider; open: boolean }>({ provider: "crowdstrike", open: false });
  const add = (provider: Provider) => setAdding({ provider, open: true });
  // IPs are looked up through one IPinfo Integration (ADR 0010).
  const hasIpinfo = integrations.data?.some((i) => i.provider === "ipinfo") ?? false;
  return (
    <>
      <PageHeader title="Integrations" actions={<AddIntegrationMenu hasIpinfo={hasIpinfo} disabled={!integrations.data} onAdd={add} />} />
      <AddIntegrationDialog
        provider={adding.provider}
        open={adding.open}
        onOpenChange={(open) => setAdding((a) => ({ ...a, open }))}
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
          <CardContent className="grid justify-items-start gap-3">
            <p className="max-w-prose text-sm text-muted-foreground">
              No Integrations yet. Start with CrowdStrike, so Falcon detections arrive as Alerts. Mimecast and Cisco Umbrella let Members
              block senders and domains from a Case, and IPinfo shows where IP addresses are and who runs them.
            </p>
            <Button variant="outline" onClick={() => add("crowdstrike")}>
              Add CrowdStrike Integration
            </Button>
          </CardContent>
        </Card>
      )}
      <TeamsChannelCard />
    </>
  );
}

/** The page's one Add action: a menu of Providers, CrowdStrike first as the source of Alerts. */
function AddIntegrationMenu({ hasIpinfo, disabled, onAdd }: { hasIpinfo: boolean; disabled: boolean; onAdd: (provider: Provider) => void }) {
  const providers: Provider[] = ["crowdstrike", "mimecast", "umbrella", "ipinfo"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={disabled}>
          <Plus aria-hidden />
          Add Integration
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {providers.map((p) => {
          const taken = p === "ipinfo" && hasIpinfo;
          return (
            <DropdownMenuItem key={p} disabled={taken} onSelect={() => onAdd(p)} className="grid items-start gap-0.5">
              <span className="font-medium">{providerLabel[p]}</span>
              <span className="text-xs text-muted-foreground">{taken ? "Already added: an Organization has one" : providerUse[p]}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>
              <h2>Teams channel</h2>
            </CardTitle>
            <Badge variant={configured ? "default" : "outline"}>{configured ? "Webhook set" : "Not set"}</Badge>
          </div>
          {configured && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={remove.isPending}>
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
          )}
        </div>
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
                save.reset();
              }}
            />
            {channel.data?.webhook && (
              <p className="text-sm text-muted-foreground">
                In use: <span className="font-mono">{channel.data.webhook.hint}</span>, set by {channel.data.webhook.updatedBy.name}{" "}
                <Time iso={channel.data.webhook.updatedAt} />
              </p>
            )}
          </div>
          <div className="grid gap-1 text-sm">
            <h3 className={sectionHeading}>Posts to the channel when</h3>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={test.isPending || (!webhookUrl && !configured)} onClick={() => test.mutate()}>
              Send test post
            </Button>
            <Button type="submit" disabled={save.isPending || !webhookUrl}>
              Save
            </Button>
            <Saved show={save.isSuccess}>Webhook saved. New posts go to this channel.</Saved>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Says, politely to screen readers, that something just saved; empty otherwise, so the live region stays in place. */
function Saved({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {show ? children : null}
    </p>
  );
}

/** A switch's mutation: puts `enabled`, then refreshes the Integrations. */
function useSwitch(put: (enabled: boolean) => Promise<Response>, fallback: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => ok(await put(enabled), fallback),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
}

function IntegrationCard({ integration: i }: { integration: IntegrationView }) {
  const queryClient = useQueryClient();
  const param = { id: i.id };
  const setPaused = useMutation({
    mutationFn: async (paused: boolean) => {
      const res = paused ? await api.integrations[":id"].pause.$post({ param }) : await api.integrations[":id"].resume.$post({ param });
      await ok(res, paused ? "Could not pause the Integration" : "Could not resume the Integration");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const setWriteBack = useSwitch(
    async (enabled) => api.integrations[":id"]["write-back"].$put({ param, json: { enabled } }),
    "Could not change write-back",
  );
  const setResponseActions = useSwitch(
    async (enabled) => api.integrations[":id"]["response-actions"].$put({ param, json: { enabled } }),
    "Could not change Response Actions",
  );
  const setHostContainment = useSwitch(
    async (enabled) => api.integrations[":id"]["host-containment"].$put({ param, json: { enabled } }),
    "Could not change Host containment",
  );
  const setWorkflows = useSwitch(async (enabled) => api.integrations[":id"].workflows.$put({ param, json: { enabled } }), "Could not change Workflows");
  const remove = useMutation({
    mutationFn: async () => ok(await api.integrations[":id"].$delete({ param }), "Could not delete the Integration"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const { receivesAlerts, writesBack, responseActions } = i.capabilities;
  const falcon = i.provider === "crowdstrike";
  const word = healthWord(i);
  // Only Admins see the credentials, and only Admins reach Settings; this only guards against a stale view.
  const locked = !i.credentials;
  const unsent = i.writeBacks.pending + i.writeBacks.retrying;
  return (
    <Card data-testid={`integration-${i.name}`}>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle>
              <h2>{i.name}</h2>
            </CardTitle>
            <Badge variant={word === "Connected" ? "default" : word === "Error" ? "outline-destructive" : "outline"}>
              {word}
            </Badge>
            {writesBack && !i.writeBack && <Badge variant="outline">Alert write-back off</Badge>}
          </div>
          <div className="flex flex-wrap gap-2">
            <PauseButton integration={i} pending={setPaused.isPending} onPause={(paused) => setPaused.mutate(paused)} />
            <RotateCredentialsDialog integration={i} />
            <DeleteIntegrationDialog integration={i} remove={remove} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* What needs attention comes first. */}
        <IntegrationProblems integration={i} pauseError={setPaused.error} />
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
        {(writesBack || responseActions) && (
          <section className={section} aria-labelledby={`allowed-${i.id}`}>
            <h3 id={`allowed-${i.id}`} className={sectionHeading}>
              What Argus may do in {providerLabel[i.provider]}
            </h3>
            <div className="grid gap-4">
              {writesBack && (
                <GuardedSwitch
                  id={`write-back-${i.id}`}
                  label="Write back to Falcon"
                  description="Send Alert Status, Assignee, comments and Case closure to CrowdStrike."
                  scope={FALCON_SCOPE.writeBack}
                  checked={setWriteBack.isPending ? setWriteBack.variables : i.writeBack}
                  disabled={locked || setWriteBack.isPending}
                  error={setWriteBack.error}
                  onChange={(enabled) => setWriteBack.mutate(enabled)}
                  confirmOn={{
                    title: `Write Alert changes back to ${i.name}?`,
                    body: (
                      <>
                        From now on, changing an Alert's Status or Assignee, commenting on it or closing its Case is sent to CrowdStrike, where your
                        Falcon console shows it. The API client needs {FALCON_SCOPE.writeBack}; without it, write-backs fail and show here.
                      </>
                    ),
                    confirm: "Turn on write-back",
                  }}
                  // Turning it off cancels what is still waiting to be sent: say so, with the count.
                  confirmOff={
                    unsent > 0
                      ? {
                          title: `Turn off write-back to ${i.name}?`,
                          body: (
                            <>
                              {counted(unsent, "Alert change")} waiting to be sent to Falcon {unsent === 1 ? "is" : "are"} cancelled and never sent. Argus
                              then only reads from {i.name}.
                            </>
                          ),
                          confirm: "Turn off and cancel",
                        }
                      : undefined
                  }
                />
              )}
              {responseActions && (
                <GuardedSwitch
                  id={`response-actions-${i.id}`}
                  label="Response Actions"
                  description={
                    falcon
                      ? "Add custom IOCs to Falcon from a Case."
                      : i.provider === "umbrella"
                        ? "Add domains to a destination list in Cisco Umbrella from a Case."
                        : `Block email senders and domains in ${providerLabel[i.provider]} from a Case.`
                  }
                  scope={falcon ? FALCON_SCOPE.iocs : i.provider === "umbrella" ? "Policies · Destination Lists, write" : "Gateway · Policies · Edit"}
                  checked={setResponseActions.isPending ? setResponseActions.variables : i.responseActions}
                  disabled={locked || setResponseActions.isPending}
                  error={setResponseActions.error}
                  onChange={(enabled) => setResponseActions.mutate(enabled)}
                  confirmOn={{
                    title: `Allow Response Actions through ${i.name}?`,
                    body: falcon ? (
                      <>
                        Members can then add custom IOCs to Falcon from a Case. The API client needs {FALCON_SCOPE.iocs}; without it, sends fail on
                        the Case with a 403.
                      </>
                    ) : i.provider === "umbrella" ? (
                      <>
                        Members can then add domains linked to a Case to the destination list chosen below. The API key needs the Policies ·
                        Destination Lists write scope; without it, adds fail on the Case.
                      </>
                    ) : (
                      <>
                        Members can then block email senders and domains from a Case. The API application's role needs Gateway · Policies · Edit;
                        without it, blocks fail on the Case.
                      </>
                    ),
                    confirm: "Allow Response Actions",
                  }}
                />
              )}
              {falcon && (
                <GuardedSwitch
                  id={`host-containment-${i.id}`}
                  label="Host containment"
                  description="Contain a host in Falcon from a Case. Containment is a Response Action allowed on its own, apart from IOCs."
                  scope={FALCON_SCOPE.containment}
                  checked={setHostContainment.isPending ? setHostContainment.variables : i.hostContainment}
                  disabled={locked || setHostContainment.isPending}
                  error={setHostContainment.error}
                  onChange={(enabled) => setHostContainment.mutate(enabled)}
                  confirmOn={{
                    title: `Allow containing hosts through ${i.name}?`,
                    body: (
                      <>
                        Any Member who can work a Case can then contain a host linked to it, cutting it off from the network except for Falcon.
                        Each containment is confirmed with the host's details first. The API client needs {FALCON_SCOPE.containment}; without it,
                        containment fails on the Case.
                      </>
                    ),
                    confirm: "Allow Host containment",
                  }}
                />
              )}
              {falcon && (
                <GuardedSwitch
                  id={`workflows-${i.id}`}
                  label="Workflows"
                  description="Run on-demand Falcon Fusion SOAR workflows from the Action Center, and follow each to its outcome."
                  scope={FALCON_SCOPE.workflows}
                  status={
                    i.workflowDiscovery &&
                    (i.workflowDiscovery.checkedAt
                      ? `${counted(i.workflowDiscovery.count, "workflow")} discovered ${ago(i.workflowDiscovery.checkedAt)}`
                      : "Discovering workflows…")
                  }
                  problem={i.workflowDiscovery?.error ?? undefined}
                  checked={setWorkflows.isPending ? setWorkflows.variables : i.workflows}
                  disabled={locked || setWorkflows.isPending}
                  error={setWorkflows.error}
                  onChange={(enabled) => setWorkflows.mutate(enabled)}
                  confirmOn={{
                    title: `Allow running Workflows through ${i.name}?`,
                    body: (
                      <>
                        Any Member can then run this tenant's on-demand Falcon Fusion SOAR workflows from the Action Center, with or without a Case.
                        A workflow does whatever it was built to do in Falcon and beyond, and can't be undone from Argus. The API client needs
                        Workflow: Write; without it, runs fail in the Action Log.
                      </>
                    ),
                    confirm: "Allow Workflows",
                  }}
                />
              )}
            </div>
          </section>
        )}
        {i.provider === "umbrella" && <DestinationListSetting integration={i} />}
        {receivesAlerts && <IgnoredSeverities integration={i} />}
        {responseActions && <ResponseActionDefaults integration={i} />}
        {writesBack && <WriteBacks counts={i.writeBacks} />}
        {responseActions && (i.responseActions || hasAny(i.responseActionCounts)) && <ResponseActionCounts counts={i.responseActionCounts} />}
        <CredentialsLine integration={i} />
      </CardContent>
    </Card>
  );
}

/** Everything wrong with the Integration, at the top of its card: errors in red, warnings in Amber Notice. */
function IntegrationProblems({ integration: i, pauseError }: { integration: IntegrationView; pauseError: Error | null }) {
  return (
    <>
      {pauseError && (
        <Alert variant="destructive">
          <AlertDescription>{pauseError.message}</AlertDescription>
        </Alert>
      )}
      {i.healthDetail && !i.paused && (
        <Alert variant={i.health === "error" ? "destructive" : "notice"}>
          <AlertDescription>{i.healthDetail}</AlertDescription>
        </Alert>
      )}
      {i.lastGap && (
        <Alert variant="notice">
          <AlertTitle>
            Gap in the stream, noticed <Time iso={i.lastGap.at} />
          </AlertTitle>
          <AlertDescription>
            Falcon could no longer replay events {i.lastGap.fromOffset.toLocaleString()}–{i.lastGap.toOffset.toLocaleString()}, so Alerts raised
            then may be missing.
          </AlertDescription>
        </Alert>
      )}
      {i.hostEnrichmentError && !i.paused && (
        <Alert variant="notice">
          <AlertDescription>
            {i.hostEnrichmentError}. Grant {FALCON_SCOPE.hosts} to the API client to see hosts' Enrichment; nothing else is affected.
          </AlertDescription>
        </Alert>
      )}
      {i.identityEnrichmentError && !i.paused && (
        <Alert variant="notice">
          <AlertDescription>{i.identityEnrichmentError}. Grant it to see accounts' Enrichment; nothing else is affected.</AlertDescription>
        </Alert>
      )}
    </>
  );
}

/** Which credentials the Integration uses and when they were set, at the foot of its card. */
function CredentialsLine({ integration: i }: { integration: IntegrationView }) {
  if (!i.credentials) return null;
  return (
    <p className="border-t pt-4 text-sm text-muted-foreground">
      {i.provider === "ipinfo" ? (
        <>
          IPinfo API token <span className="font-mono">{i.credentials.clientIdHint}</span>
        </>
      ) : (
        <>
          {i.provider === "crowdstrike" && i.cloud
            ? `Falcon API credentials: ${falconCloudLabel[i.cloud]} cloud`
            : i.provider === "umbrella"
              ? "Umbrella API"
              : `${providerLabel[i.provider]} API 2.0 credentials`}{" "}
          · {i.provider === "umbrella" ? "key" : "client"} <span className="font-mono">{i.credentials.clientIdHint}</span>
        </>
      )}{" "}
      · set <Time iso={i.credentials.updatedAt} />
    </p>
  );
}

/** Pause asks first, saying what stops; Resume doesn't. */
function PauseButton({ integration: i, pending, onPause }: { integration: IntegrationView; pending: boolean; onPause: (paused: boolean) => void }) {
  if (i.paused) {
    return (
      <Button variant="outline" size="sm" disabled={pending} onClick={() => onPause(false)}>
        Resume
      </Button>
    );
  }
  const { receivesAlerts, looksUpIps } = i.capabilities;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          Pause
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Pause {i.name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <Alert variant="notice">
                <AlertDescription>
                  {receivesAlerts
                    ? "Argus stops reading its Alert stream, so no new Alerts arrive from it until you resume it. Events Falcon no longer holds by then show here as a gap."
                    : looksUpIps
                      ? "Argus stops looking IP addresses up through it and shows only what it already has until you resume it."
                      : "Members can't take Response Actions through it until you resume it."}{" "}
                  Nothing already received or taken changes.
                </AlertDescription>
              </Alert>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onPause(true)}>Pause Integration</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Deleting an Integration (ADR 0013), confirmed first: it stops for good and leaves this page, but
 * what came in or was done through it stays where it is. While Response Actions taken through it are
 * still in place the dialog says so instead of offering a delete the API would refuse.
 */
function DeleteIntegrationDialog({
  integration: i,
  remove,
}: {
  integration: IntegrationView;
  remove: { mutate: (v: void, o: { onSuccess: () => void }) => void; isPending: boolean; error: Error | null; reset: () => void };
}) {
  const [open, setOpen] = useState(false);
  const { receivesAlerts, responseActions, looksUpIps } = i.capabilities;
  const held = responseActions ? i.responseActionCounts.active + i.responseActionCounts.pending : 0;
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
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) remove.reset();
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={remove.isPending}>
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {i.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {stops} {kept.length > 0 && `${capitalized(kept.join(" and "))} stay, under its name. `}It can't be resumed: to connect again, add a
            new Integration.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {held > 0 && (
          <Alert variant="notice">
            <AlertDescription>
              {counted(held, "Response Action")} taken through it {held === 1 ? "is" : "are"} still in place. Remove{" "}
              {held === 1 ? "it from its Case" : "them from their Cases"} first; the{" "}
              <Link to="/actions/log" className="underline underline-offset-2">
                Action Log
              </Link>{" "}
              lists them.
            </AlertDescription>
          </Alert>
        )}
        {remove.error && (
          <Alert variant="destructive">
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={held > 0 || remove.isPending}
            onClick={(e) => {
              // Stays open until the API answers, so a refusal shows here.
              e.preventDefault();
              remove.mutate(undefined, { onSuccess: () => setOpen(false) });
            }}
          >
            Delete Integration
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The Integration's write-backs to Falcon by where they stand, then what happened over the last 24 hours. */
function WriteBacks({ counts: w }: { counts: IntegrationView["writeBacks"] }) {
  return (
    <section className={section} data-testid="write-backs" aria-label="Write-backs to Falcon">
      <h3 className={sectionHeading}>Write-backs to Falcon</h3>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">Pending {w.pending}</Badge>
        <Badge variant={w.retrying ? "outline-notice" : "outline"}>
          Retrying {w.retrying}
          {w.nextRetryAt ? ` · next ${until(w.nextRetryAt)}` : ""}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Last 24 h: {w.sent} sent · {w.skipped} skipped, no Falcon user with the Assignee's email
        {w.failed > 0 && (
          <>
            {" "}
            · <span className="font-medium text-destructive">{w.failed} failed</span>
          </>
        )}
      </p>
      {w.lastError && (
        <p className="text-sm">
          <span className="text-muted-foreground">Last failure: </span>
          {w.lastError}
        </p>
      )}
    </section>
  );
}

const hasAny = (c: IntegrationView["responseActionCounts"]) => c.pending + c.active + c.failed > 0;

/** What Argus holds in the tool through this Integration, and what is waiting or failed. */
function ResponseActionCounts({ counts: c }: { counts: IntegrationView["responseActionCounts"] }) {
  return (
    <section className={section} data-testid="response-action-counts" aria-label="Response Actions through this Integration">
      <h3 className={sectionHeading}>Response Actions through this Integration</h3>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">Active {c.active}</Badge>
        <Badge variant="outline">Pending {c.pending}</Badge>
        {c.failed > 0 && (
          <Badge variant="outline-destructive">
            Failed {c.failed}
          </Badge>
        )}
      </div>
      {c.lastError && (
        <p className="text-sm">
          <span className="text-muted-foreground">Last failure: </span>
          {c.lastError}
        </p>
      )}
      {(c.failed > 0 || c.lastError) && (
        <p className="text-sm text-muted-foreground">
          Each one, with its Case and how it went, is in the{" "}
          <Link to="/actions/log" className="text-foreground underline underline-offset-2">
            Action Log
          </Link>
          .
        </p>
      )}
    </section>
  );
}

/** The stream at a glance (its last event), with the worker's bookkeeping folded away. */
function StreamSummary({ integration: i }: { integration: IntegrationView }) {
  const [open, setOpen] = useState(false);
  const connecting = i.health === "connecting" && !i.paused;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span className="text-muted-foreground">Last event </span>
          {i.lastEventAt ? <Time iso={i.lastEventAt} className="font-medium" /> : <span className="font-medium">None yet</span>}
        </span>
        <CollapsibleTrigger asChild>
          <Button variant="quiet" size="xs">
            <ChevronRight className={open ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden />
            Stream details
          </Button>
        </CollapsibleTrigger>
      </div>
      {connecting && (
        <p className="text-muted-foreground">
          {i.lastEventAt
            ? "Opening the Falcon stream again; it carries on from the last event."
            : "Checking the credentials and opening the Falcon stream. Alerts appear in the queue as detections come in."}
        </p>
      )}
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

type Confirmation = { title: string; body: ReactNode; confirm: string };

/**
 * A setting's switch, with what it does, the scope it needs, and its last error under it. Turning it
 * on asks first when `confirmOn` is given (it reaches outside Argus); turning it off asks first when
 * `confirmOff` is (it would lose something).
 */
function GuardedSwitch({
  id,
  label,
  description,
  scope,
  status,
  problem,
  checked,
  disabled,
  error,
  onChange,
  confirmOn,
  confirmOff,
}: {
  id: string;
  label: string;
  description: string;
  /** The scope or role the tool's credentials need for it. */
  scope: string;
  /** A live fact about it, on its own line. */
  status?: ReactNode;
  /** Why it can't work as things stand. */
  problem?: string;
  checked?: boolean;
  disabled?: boolean;
  error: Error | null;
  onChange: (enabled: boolean) => void;
  confirmOn?: Confirmation;
  confirmOff?: Confirmation;
}) {
  const [asking, setAsking] = useState<boolean | null>(null);
  const confirmation = asking === null ? undefined : asking ? confirmOn : confirmOff;
  const describedBy = `${id}-description`;
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onCheckedChange={(next) => ((next ? confirmOn : confirmOff) ? setAsking(next) : onChange(next))}
      />
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        <div id={describedBy} className="grid max-w-prose gap-0.5 text-sm text-muted-foreground">
          <p>
            {description} Needs {scope}.
          </p>
          {status && <p className="text-xs">{status}</p>}
        </div>
        {problem && <p className="text-sm text-destructive">{problem}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
      </div>
      <AlertDialog open={confirmation !== undefined} onOpenChange={(open) => !open && setAsking(null)}>
        {confirmation && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmation.title}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div>
                  <Alert variant="notice">
                    <AlertDescription>{confirmation.body}</AlertDescription>
                  </Alert>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => asking !== null && onChange(asking)}>{confirmation.confirm}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
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
    <section className={section} data-testid="destination-list" aria-labelledby={`destination-list-heading-${i.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 id={`destination-list-heading-${i.id}`} className={sectionHeading}>
            Destination list
          </h3>
          <p className="text-sm text-muted-foreground">
            {current ? (
              <>
                Domains are added to <span className="font-medium text-foreground">{current.name}</span> ({current.access === "block" ? "Block" : "Allow"}
                ).
              </>
            ) : (
              "None chosen yet: Members can't add domains to Umbrella until an Admin chooses one."
            )}
          </p>
          <Saved show={save.isSuccess && !choosing}>Saved.</Saved>
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
    </section>
  );
}

/**
 * A setting shown as one summary line with Edit, opening into its form in place. Saving folds it
 * back and says so. `form` is the form's name for screen readers and tests.
 */
function EditableSetting({
  name,
  heading,
  summary,
  editing,
  saved,
  locked,
  onEdit,
  onSubmit,
  testId,
  children,
}: {
  name: string;
  heading: string;
  summary: ReactNode;
  editing: boolean;
  saved: boolean;
  locked: boolean;
  onEdit: () => void;
  onSubmit: () => void;
  testId: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <form
      className={section}
      aria-label={name}
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 id={headingId} className={sectionHeading}>
            {heading}
          </h3>
          <p className="max-w-prose text-sm text-muted-foreground">{summary}</p>
          <Saved show={saved && !editing}>Saved.</Saved>
        </div>
        {!locked && !editing && (
          <Button type="button" variant="outline" size="sm" aria-describedby={headingId} onClick={onEdit}>
            Edit
          </Button>
        )}
      </div>
      {editing && children}
    </form>
  );
}

/** Save and Cancel under a setting being edited. */
function EditActions({ save, disabled, onCancel }: { save: string; disabled: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" size="sm" disabled={disabled}>
        {save}
      </Button>
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Severity[]>(saved);
  const save = useMutation({
    mutationFn: async (severities: Severity[]) =>
      ok(await api.integrations[":id"]["ignored-severities"].$put({ param: { id: i.id }, json: { severities } }), "Could not save the ignored Severities"),
    // Folds back once the saved value is in, so the summary never shows the old one.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      setEditing(false);
    },
    onError: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const changed = SEVERITIES.some((s) => draft.includes(s) !== saved.includes(s));
  const all = draft.length === SEVERITIES.length;
  const toggle = (severity: Severity, on: boolean) => setDraft((d) => SEVERITIES.filter((s) => (s === severity ? on : d.includes(s))));
  const id = (severity: Severity) => `ignored-severity-${severity}-${i.id}`;
  const errorId = `ignored-severities-error-${i.id}`;
  const ignoring = SEVERITIES.filter((s) => saved.includes(s)).map((s) => severityLabel[s]);
  return (
    <EditableSetting
      name="Ignored Severities"
      heading="Ignored Severities"
      testId="ignored-severities"
      summary={
        ignoring.length === 0
          ? "None: detections of every Severity become Alerts."
          : `${listed(ignoring)}: detections of ${ignoring.length === 1 ? "this Severity are" : "these Severities are"} skipped and don't become Alerts. Alerts already received are kept.`
      }
      editing={editing}
      saved={save.isSuccess}
      locked={!i.credentials}
      onEdit={() => {
        setDraft(saved);
        save.reset();
        setEditing(true);
      }}
      onSubmit={() => changed && !all && save.mutate(draft)}
    >
      <div className="flex flex-wrap gap-4" role="group" aria-label="Severities to ignore" aria-describedby={all ? errorId : undefined}>
        {SEVERITIES.map((s) => (
          <div key={s} className="flex items-center gap-2">
            <Checkbox id={id(s)} checked={draft.includes(s)} aria-invalid={all || undefined} onCheckedChange={(checked) => toggle(s, checked === true)} />
            <Label htmlFor={id(s)} variant="option">
              {severityLabel[s]}
            </Label>
          </div>
        ))}
      </div>
      <p id={errorId} role="alert" className="text-xs text-destructive empty:hidden">
        {all && "Leave at least one Severity unignored. To stop receiving Alerts, pause the Integration."}
      </p>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      <EditActions save="Save ignored Severities" disabled={!changed || all || save.isPending} onCancel={() => setEditing(false)} />
    </EditableSetting>
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FalconIocDefaults>(saved);
  const save = useMutation({
    mutationFn: async (next: FalconIocDefaults) =>
      ok(await api.integrations[":id"]["response-action-defaults"].$put({ param: { id: i.id }, json: next }), "Could not save the defaults"),
    // Folds back once the saved value is in, so the summary never shows the old one.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      setEditing(false);
    },
    onError: () => queryClient.invalidateQueries({ queryKey: integrationsKey }),
  });
  const changed =
    draft.severity !== saved.severity ||
    draft.internal !== saved.internal ||
    FALCON_IOC_PLATFORMS.some((p) => draft.platforms.includes(p) !== saved.platforms.includes(p));
  const togglePlatform = (p: FalconIocPlatform, on: boolean) =>
    setDraft((d) => ({ ...d, platforms: FALCON_IOC_PLATFORMS.filter((x) => (x === p ? on : d.platforms.includes(x))) }));
  const id = (field: string) => `ioc-defaults-${field}-${i.id}`;
  const falcon = i.provider === "crowdstrike";
  const noPlatform = draft.platforms.length === 0;
  const visibility = saved.internal ? "start Internal" : "start visible to Guests";
  const summary = falcon
    ? `Sent as ${saved.severity === "case" ? "the Case's Severity" : severityLabel[saved.severity]}, for ${listed(
        FALCON_IOC_PLATFORMS.filter((p) => saved.platforms.includes(p)).map((p) => falconIocPlatformLabel[p]),
      )}; they ${visibility}.`
    : `New ones ${visibility}.`;
  return (
    <EditableSetting
      name="Response Action defaults"
      heading={falcon ? "IOC defaults" : i.provider === "umbrella" ? "Destination list defaults" : "Block defaults"}
      testId="response-action-defaults"
      summary={summary}
      editing={editing}
      saved={save.isSuccess}
      locked={!i.credentials}
      onEdit={() => {
        setDraft(saved);
        save.reset();
        setEditing(true);
      }}
      onSubmit={() => changed && !noPlatform && save.mutate(draft)}
    >
      <div className="grid gap-2 @lg:grid-cols-[10rem_1fr] @lg:items-center">
        {falcon && (
          <>
            <Label htmlFor={id("severity")}>Severity</Label>
            <NativeSelect
              id={id("severity")}
              value={draft.severity}
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
            <div className="flex flex-wrap gap-4" role="group" aria-label="Platforms" aria-describedby={noPlatform ? id("error") : undefined}>
              {FALCON_IOC_PLATFORMS.map((p) => (
                <div key={p} className="flex items-center gap-2">
                  <Checkbox
                    id={id(p)}
                    checked={draft.platforms.includes(p)}
                    aria-invalid={noPlatform || undefined}
                    onCheckedChange={(checked) => togglePlatform(p, checked === true)}
                  />
                  <Label htmlFor={id(p)} variant="option">
                    {falconIocPlatformLabel[p]}
                  </Label>
                </div>
              ))}
            </div>
          </>
        )}
        <span className="text-sm font-medium">Visibility</span>
        <div className="flex items-center gap-2">
          <Checkbox id={id("internal")} checked={draft.internal} onCheckedChange={(checked) => setDraft((d) => ({ ...d, internal: checked === true }))} />
          <Label htmlFor={id("internal")} variant="option">
            Internal
          </Label>
        </div>
      </div>
      <p id={id("error")} role="alert" className="text-xs text-destructive empty:hidden">
        {noPlatform && "Choose at least one platform."}
      </p>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      <EditActions save="Save defaults" disabled={!changed || noPlatform || save.isPending} onCancel={() => setEditing(false)} />
    </EditableSetting>
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

/** Every Falcon scope Argus uses, the one it can't work without first; the switches name the same ones. */
function FalconScopeList() {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {FALCON_SCOPES.map((s) => (
        <div key={s.scope} className="contents">
          <dt className="font-medium">{s.scope}</dt>
          <dd className="text-muted-foreground">
            {s.required ? "Required, for" : "For"} {s.use}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Adds a CrowdStrike Integration, a Mimecast or Cisco Umbrella one, which have no cloud, Alert stream
 * or write-back, or the IPinfo one, which only looks IPs up (ADR 0010). What reaches outside Argus
 * starts off; Admins turn it on from the Integration's card, where each switch asks first.
 */
function AddIntegrationDialog({ provider, open, onOpenChange }: { provider: Provider; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const falcon = provider === "crowdstrike";
  const [cloud, setCloud] = useState<FalconCloud>("us-1");
  const add = useMutation({
    mutationFn: async (
      json:
        | { provider: "crowdstrike"; name: string; cloud: FalconCloud; clientId: string; clientSecret: string }
        | { provider: "mimecast" | "umbrella"; name: string; clientId: string; clientSecret: string }
        | { provider: "ipinfo"; name: string; token: string },
    ) => ok(await api.integrations.$post({ json }), "Could not add the Integration"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      onOpenChange(false);
    },
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (provider === "ipinfo") return add.mutate({ provider, name: String(form.get("name")), ...tokenFrom(form) });
    const common = { name: String(form.get("name")), ...credentialsFrom(form) };
    add.mutate(falcon ? { provider, ...common, cloud } : { provider: provider === "umbrella" ? "umbrella" : "mimecast", ...common });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) add.reset();
      }}
    >
      <DialogContent
        onOpenAutoFocus={() => {
          add.reset();
          setCloud("us-1");
        }}
      >
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
              it is added, choose the destination list Argus adds domains to and turn on Response Actions from its card.
            </DialogDescription>
          )}
          {provider === "mimecast" && (
            <DialogDescription>
              Create an API 2.0 application in the Mimecast Administration Console whose role has Gateway · Policies · Edit. Once it is added,
              turn on Response Actions from its card.
            </DialogDescription>
          )}
          {falcon && (
            <DialogDescription>
              Create an API client in the Falcon console with these scopes. Grant all of them now to avoid coming back; write-back and every
              action in Falcon stay off until you turn them on from the Integration's card.
            </DialogDescription>
          )}
        </DialogHeader>
        {falcon && <FalconScopeList />}
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className={falcon ? "grid gap-4 @lg:grid-cols-[1fr_auto]" : "grid gap-4"}>
            <div className="grid gap-2">
              <Label htmlFor="integration-name">Name</Label>
              <Input
                id="integration-name"
                name="name"
                required
                maxLength={80}
                aria-describedby="integration-name-hint"
                defaultValue={provider === "ipinfo" ? "IPinfo" : undefined}
              />
              <p id="integration-name-hint" className="text-xs text-muted-foreground">
                {falcon ? "Shown on its Alerts and actions, such as “CrowdStrike — Prod”." : "Shown on the actions taken through it."}
              </p>
            </div>
            {falcon && (
              <div className="grid content-start gap-2">
                <Label htmlFor="integration-cloud">Falcon cloud</Label>
                <NativeSelect
                  id="integration-cloud"
                  name="cloud"
                  value={cloud}
                  aria-describedby="integration-cloud-hint"
                  onChange={(e) => setCloud(e.target.value as FalconCloud)}
                >
                  {FALCON_CLOUDS.map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {falconCloudLabel[c]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <p id="integration-cloud-hint" className="text-xs text-muted-foreground">
                  Console at <span className="font-mono">{new URL(FALCON_CONSOLES[cloud]).host}</span>
                </p>
              </div>
            )}
          </div>
          <CredentialFields provider={provider} />
          {add.error && (
            <Alert variant="destructive">
              <AlertDescription>{add.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={add.isPending}>
              Add Integration
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateCredentialsDialog({ integration: i }: { integration: IntegrationView }) {
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const token = i.provider === "ipinfo";
  const rotate = useMutation({
    mutationFn: async (json: { clientId: string; clientSecret: string } | { token: string }) =>
      ok(await api.integrations[":id"].credentials.$put({ param: { id: i.id }, json }), "Could not rotate the credentials"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      setIsOpen(false);
    },
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    rotate.mutate(token ? tokenFrom(form) : credentialsFrom(form));
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
          {token ? "Rotate token" : "Rotate credentials"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Rotate {token ? "the token" : "credentials"} of {i.name}
          </DialogTitle>
          <DialogDescription>
            {i.capabilities.receivesAlerts
              ? "The stream reconnects with the new credentials and carries on from its last event. The new API client needs the same scopes as the old one."
              : `Argus stops using the old ${token ? "token" : "credentials"} and checks the new ${token ? "one" : "ones"}; the badge says Connecting until then.`}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <CredentialFields provider={i.provider} />
          {rotate.error && (
            <Alert variant="destructive">
              <AlertDescription>{rotate.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={rotate.isPending}>
              {token ? "Rotate token" : "Rotate credentials"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
