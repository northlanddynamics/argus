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
import { ago, FALCON_CLOUDS, type FalconCloud, falconCloudLabel, healthWord, type IntegrationView, integrationsKey, integrationsQuery } from "@/lib/alerts";
import { api, errorMessage } from "@/lib/api";
import { useLiveStatus } from "@/lib/live";

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
    </>
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
  const word = healthWord(i);
  return (
    <Card data-testid={`integration-${i.name}`}>
      <CardHeader className="border-b">
        <div className="flex items-center gap-3 self-center">
          <CardTitle>{i.name}</CardTitle>
          <Badge variant={word === "Connected" ? "default" : "outline"} className={word === "Error" ? "border-destructive text-destructive" : undefined}>
            {word}
          </Badge>
        </div>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="sm" disabled={setPaused.isPending} onClick={() => setPaused.mutate(!i.paused)}>
            {i.paused ? "Resume" : "Pause"}
          </Button>
          <RotateCredentialsDialog integration={i} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid gap-3 sm:grid-cols-4">
          <Stat label="Last event" value={i.lastEventAt ? ago(i.lastEventAt) : "None yet"} />
          <Stat label="Stream session refresh" value={i.sessionRefreshAt ? until(i.sessionRefreshAt) : "—"} />
          <Stat label="Stored offset" value={i.streamOffset === null ? "—" : i.streamOffset.toLocaleString()} mono />
          <Stat label="Owned by worker" value={i.workerId ?? "—"} mono />
        </dl>
        {i.healthDetail && !i.paused && (
          <Alert variant={i.health === "error" ? "destructive" : "default"}>
            <AlertDescription>{i.healthDetail}</AlertDescription>
          </Alert>
        )}
        {i.lastGap && (
          <Alert className="border-amber-400 bg-amber-50 text-amber-950">
            <AlertTitle>Gap in the stream, noticed {new Date(i.lastGap.at).toLocaleString()}</AlertTitle>
            <AlertDescription>
              Falcon could no longer replay events {i.lastGap.fromOffset.toLocaleString()}–{i.lastGap.toOffset.toLocaleString()}, so
              Alerts raised then may be missing. Recorded in the Organization Audit Log; not backfilled.
            </AlertDescription>
          </Alert>
        )}
        {setPaused.error && (
          <Alert variant="destructive">
            <AlertDescription>{setPaused.error.message}</AlertDescription>
          </Alert>
        )}
        {i.credentials && (
          <p className="text-sm text-muted-foreground">
            Falcon API credentials: {falconCloudLabel[i.cloud]} cloud · client {i.credentials.clientIdHint} · set{" "}
            {new Date(i.credentials.updatedAt).toLocaleDateString()}
          </p>
        )}
      </CardContent>
    </Card>
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
    mutationFn: async (json: { name: string; cloud: FalconCloud; clientId: string; clientSecret: string }) =>
      ok(await api.integrations.$post({ json }), "Could not add the Integration"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationsKey });
      setIsOpen(false);
    },
  });
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    add.mutate({ name: String(form.get("name")), cloud: form.get("cloud") as FalconCloud, ...credentialsFrom(form) });
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
            An API client with Event Streams read access. A worker connects with it and turns Falcon detections into Alerts.
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
          <DialogDescription>The worker reconnects with the new credentials and resumes from the stored offset.</DialogDescription>
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
