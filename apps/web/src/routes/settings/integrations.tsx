import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { ago, FALCON_CLOUDS, type FalconCloud, falconCloudLabel, healthWord, type IntegrationView, integrationsKey, integrationsQuery } from "@/lib/alerts";
import { api, errorMessage } from "@/lib/api";
import { useLiveStatus } from "@/lib/live";
import { type Provider, providerLabel } from "api/integrations/vocabulary";

/** Throws the API's error message unless `res` is OK. */
async function ok(res: Response, fallback: string) {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
}

/** "in 18 min", or "due" once it has passed. */
const until = (iso: string) => {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  return minutes <= 0 ? "due" : `in ${minutes} min`;
};

/** Settings · Integrations: the Organization's CrowdStrike Integrations and how their streams are doing. */
export function IntegrationsPage() {
  const integrations = useQuery(integrationsQuery);
  // Health and the last event refresh live.
  useLiveStatus();
  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <AddIntegrationDialog />
      </div>
      {integrations.data?.map((i) => <IntegrationCard key={i.id} integration={i} />)}
      {integrations.data?.length === 0 && (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No Integrations yet. Add a CrowdStrike Integration to receive Falcon detections as Alerts.
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
            <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
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
          {writesBack && !i.writeBack && <Badge variant="outline">Read only</Badge>}
        </div>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="sm" disabled={setPaused.isPending} onClick={() => setPaused.mutate(!i.paused)}>
            {i.paused ? "Resume" : "Pause"}
          </Button>
          <RotateCredentialsDialog integration={i} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {receivesAlerts && (
          <dl className="grid gap-3 sm:grid-cols-4">
            <Stat label="Last event" value={i.lastEventAt ? ago(i.lastEventAt) : "None yet"} />
            <Stat label="Stream session refresh" value={i.sessionRefreshAt ? until(i.sessionRefreshAt) : "—"} />
            <Stat label="Stored offset" value={i.streamOffset === null ? "—" : i.streamOffset.toLocaleString()} mono />
            <Stat label="Owned by worker" value={i.workerId ?? "—"} mono />
          </dl>
        )}
        {i.healthDetail && !i.paused && (
          <Alert variant={i.health === "error" ? "destructive" : "default"}>
            <AlertDescription>{i.healthDetail}</AlertDescription>
          </Alert>
        )}
        {i.lastGap && (
          <Alert className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
            <AlertTitle>Gap in the stream, noticed {new Date(i.lastGap.at).toLocaleString()}</AlertTitle>
            <AlertDescription>
              Falcon could no longer replay events {i.lastGap.fromOffset.toLocaleString()}–{i.lastGap.toOffset.toLocaleString()}, so
              Alerts raised then may be missing. Not backfilled.
            </AlertDescription>
          </Alert>
        )}
        {setPaused.error && (
          <Alert variant="destructive">
            <AlertDescription>{setPaused.error.message}</AlertDescription>
          </Alert>
        )}
        {writesBack && (
          <WriteBackSetting
            id={`write-back-${i.id}`}
            checked={setWriteBack.isPending ? setWriteBack.variables : i.writeBack}
            // Only Admins (who see the credentials) may change it.
            disabled={!i.credentials || setWriteBack.isPending}
            onCheckedChange={(enabled) => setWriteBack.mutate(enabled)}
          />
        )}
        {setWriteBack.error && (
          <Alert variant="destructive">
            <AlertDescription>{setWriteBack.error.message}</AlertDescription>
          </Alert>
        )}
        {responseActions && (
          <ResponseActionsSetting
            id={`response-actions-${i.id}`}
            provider={i.provider}
            checked={setResponseActions.isPending ? setResponseActions.variables : i.responseActions}
            disabled={!i.credentials || setResponseActions.isPending}
            onCheckedChange={(enabled) => setResponseActions.mutate(enabled)}
          />
        )}
        {setResponseActions.error && (
          <Alert variant="destructive">
            <AlertDescription>{setResponseActions.error.message}</AlertDescription>
          </Alert>
        )}
        {writesBack && <WriteBacks counts={i.writeBacks} />}
        {i.credentials && (
          <p className="text-sm text-muted-foreground">
            {i.provider === "crowdstrike" ? `Falcon API credentials: ${falconCloudLabel[i.cloud]} cloud` : `${providerLabel[i.provider]} API credentials`}{" "}
            · client {i.credentials.clientIdHint} · set{" "}
            {new Date(i.credentials.updatedAt).toLocaleDateString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The Integration's write-backs to Falcon by where they stand; sent, skipped and failed over the last 24 hours. */
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

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono font-semibold" : "font-semibold"}>{value}</dd>
    </div>
  );
}

/** The write-back switch: on, Argus writes Alert changes back to Falcon; off, it only reads. */
function WriteBackSetting(props: { id: string; checked?: boolean; defaultChecked?: boolean; disabled?: boolean; name?: string; onCheckedChange?: (checked: boolean) => void }) {
  const { id, ...rest } = props;
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} className="mt-0.5" {...rest} />
      <div className="grid gap-1">
        <Label htmlFor={id}>Write back to Falcon</Label>
        <p className="text-sm text-muted-foreground">
          Send Alert Status, Assignee, comments and Case closure to CrowdStrike.
        </p>
      </div>
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
  onCheckedChange?: (checked: boolean) => void;
}) {
  const { id, provider, ...rest } = props;
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} className="mt-0.5" {...rest} />
      <div className="grid gap-1">
        <Label htmlFor={id}>Response Actions</Label>
        <p className="text-sm text-muted-foreground">
          {provider === "crowdstrike"
            ? "Add custom IOCs to Falcon from a Case. The API client needs IOC Management write scope."
            : `Take Response Actions in ${providerLabel[provider]} from a Case.`}
        </p>
      </div>
    </div>
  );
}

function CredentialFields() {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="falcon-client-id">API client ID</Label>
        <Input id="falcon-client-id" name="clientId" required autoComplete="off" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="falcon-client-secret">API client secret</Label>
        <Input id="falcon-client-secret" name="clientSecret" type="password" required autoComplete="new-password" />
      </div>
    </>
  );
}

const credentialsFrom = (form: FormData) => ({ clientId: String(form.get("clientId")), clientSecret: String(form.get("clientSecret")) });

function AddIntegrationDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: async (json: {
      name: string;
      cloud: FalconCloud;
      clientId: string;
      clientSecret: string;
      writeBack: boolean;
      responseActions: boolean;
    }) =>
      ok(await api.integrations.$post({ json }), "Could not add the Integration"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      setIsOpen(false);
    },
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    add.mutate({
      name: String(form.get("name")),
      cloud: form.get("cloud") as FalconCloud,
      writeBack: form.get("writeBack") === "on",
      responseActions: form.get("responseActions") === "on",
      ...credentialsFrom(form),
    });
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
        <Button>+ Add CrowdStrike Integration</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a CrowdStrike Integration</DialogTitle>
          <DialogDescription>
            An API client with Event Streams read access (Alerts write access for write-back, IOC Management write access for
            Response Actions).
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="grid gap-2">
              <Label htmlFor="integration-name">Name</Label>
              <Input id="integration-name" name="name" required maxLength={80} placeholder="CrowdStrike — Prod" />
            </div>
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
          </div>
          <CredentialFields />
          <WriteBackSetting id="integration-write-back" name="writeBack" defaultChecked={false} />
          <ResponseActionsSetting id="integration-response-actions" provider="crowdstrike" name="responseActions" defaultChecked={false} />
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
    mutationFn: async (json: { clientId: string; clientSecret: string }) =>
      ok(await api.integrations[":id"].credentials.$put({ param: { id: integration.id }, json }), "Could not rotate the credentials"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      setIsOpen(false);
    },
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    rotate.mutate(credentialsFrom(new FormData(event.currentTarget)));
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
          Rotate credentials
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate credentials of {integration.name}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <CredentialFields />
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
