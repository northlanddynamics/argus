import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
  containHost,
  type ContainmentDevice,
  type ContainmentIntegration,
  containmentCheckKey,
  containmentCheckQuery,
  liftForeignContainment,
  requestContainmentCheck,
  responseActionsKey,
} from "@/lib/response-actions";
import { exactTime, when } from "@/lib/when";

/** The Amber Notice treatment (DESIGN.md): the one warning style. */
const notice = "border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80";

const containmentLabel: Record<NonNullable<ContainmentDevice["containment"]>, string> = {
  normal: "Not contained",
  containment_pending: "Containment pending",
  contained: "Contained",
  lift_containment_pending: "Lifting containment",
};

/** Falcon reports it contained, or being contained. */
const isContained = (d: ContainmentDevice) => d.containment === "contained" || d.containment === "containment_pending";

/** Fetched afresh since the confirmation opened, without error: what may be contained. */
const fresh = (d: ContainmentDevice) => !d.refreshing && d.fetchedAt !== null && !d.notFound && d.error === null;

/**
 * "Contain host…" (ADR 0009): never one click. Opening it asks Falcon for the host afresh, through the
 * worker, and shows each of its devices as Falcon now reports it: hostname, `aid`, platform, host
 * groups, last seen and containment. The Member picks the Integration where there are several, and
 * the device where the host is ambiguous (nothing is picked for them then). Confirming is allowed only
 * once the device picked has been fetched afresh. A host with no device can't be contained.
 *
 * With `lift`, it is "Lift containment…" instead, for Admins (ADR 0009): the same check, then a
 * warning that Argus didn't contain the host and as of when Falcon reports it contained. Only a device
 * Falcon reports contained (or being contained) can have its containment lifted.
 */
export function ContainHostDialog({
  number,
  asset,
  integrations,
  lift = false,
  onClose,
}: {
  number: number;
  asset: { id: string; value: string };
  integrations: ContainmentIntegration[];
  lift?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const request = useMutation({
    mutationFn: () => requestContainmentCheck(number, asset.id),
    onSuccess: (check) => queryClient.setQueryData(containmentCheckKey(number, asset.id), check),
  });
  // Asked once, as it opens: `mutate` is stable.
  const ask = request.mutate;
  useEffect(() => ask(), [ask]);
  const check = useQuery({
    ...containmentCheckQuery(number, asset.id),
    enabled: request.isSuccess,
    // Until the worker has fetched every device (a signal also brings it).
    refetchInterval: (q) =>
      q.state.data?.integrations.some((i) => i.lookup?.refreshing || i.devices.some((d) => d.refreshing)) ? 1000 : false,
  });
  const [integrationId, setIntegrationId] = useState(integrations.length === 1 ? integrations[0]!.id : "");
  const [deviceId, setDeviceId] = useState("");
  const shown = request.isSuccess ? check.data?.integrations.find((i) => i.integration.id === integrationId) : undefined;
  // One device is picked for the Member; of several, none is.
  const onlyDevice = shown && shown.devices.length === 1 ? shown.devices[0]!.deviceId : "";
  const picked = shown?.devices.find((d) => d.deviceId === (deviceId || onlyDevice));

  const contain = useMutation({
    mutationFn: () =>
      (lift ? liftForeignContainment : containHost)(number, { assetId: asset.id, integrationId, deviceId: picked!.deviceId }),
    onSuccess: () => {
      toast(lift ? `Lifting the containment of ${asset.value} queued` : `Containment of ${asset.value} queued`);
      onClose();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: responseActionsKey(number) }),
  });

  return (
    <Dialog defaultOpen onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{lift ? `Lift the containment of ${asset.value}?` : `Contain ${asset.value}?`}</DialogTitle>
          <DialogDescription>
            {lift
              ? "Falcon puts the host back on the network. Any Argus records of its containment, on any Case, end."
              : "Falcon cuts the host off from the network, except for Falcon itself, until containment is lifted. Check the host groups: a server or domain controller going offline affects everyone who relies on it."}
          </DialogDescription>
        </DialogHeader>

        {integrations.length > 1 && (
          <FieldSet>
            <FieldLegend variant="label">Through</FieldLegend>
            <RadioGroup
              value={integrationId}
              onValueChange={(v) => {
                setIntegrationId(v);
                setDeviceId("");
              }}
            >
              {integrations.map((i) => (
                <FieldLabel key={i.id} htmlFor={`contain-through-${i.id}`}>
                  <Field orientation="horizontal">
                    <RadioGroupItem value={i.id} id={`contain-through-${i.id}`} />
                    <FieldContent>
                      <FieldTitle>{i.name}</FieldTitle>
                    </FieldContent>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>
        )}

        {request.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{request.error.message}</AlertDescription>
          </Alert>
        ) : !integrationId ? null : !shown ? (
          <Skeleton className="h-24 w-full" />
        ) : shown.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {shown.lookup?.refreshing
              ? "Looking the host up in Falcon…"
              : shown.lookup?.error
                ? `Couldn't look the host up in Falcon: ${shown.lookup.error}`
                : "Falcon knows no device by this hostname, so it can't be contained."}
          </p>
        ) : (
          <FieldSet aria-live="polite">
            <FieldLegend variant="label">{shown.ambiguous ? "Falcon knows several devices by this name. Pick one." : "Device"}</FieldLegend>
            <RadioGroup value={picked?.deviceId ?? ""} onValueChange={setDeviceId}>
              {shown.devices.map((d) => (
                <FieldLabel key={d.deviceId} htmlFor={`contain-device-${d.deviceId}`}>
                  <Field orientation="horizontal" className="items-start">
                    <RadioGroupItem value={d.deviceId} id={`contain-device-${d.deviceId}`} className="mt-0.5" />
                    <FieldContent>
                      <DeviceFacts device={d} />
                    </FieldContent>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>
        )}

        {!lift && picked && isContained(picked) && (
          <Alert className={notice}>
            <AlertDescription>Falcon already reports this device {containmentLabel[picked.containment!].toLowerCase()}. Argus records it and sends nothing.</AlertDescription>
          </Alert>
        )}
        {lift && picked && fresh(picked) && (
          <Alert className={notice}>
            <AlertDescription>
              {isContained(picked) ? (
                <>
                  Argus didn't contain this host: someone did in Falcon, or it was already contained when Argus looked. Falcon reports it{" "}
                  {containmentLabel[picked.containment!].toLowerCase()} as of{" "}
                  <time dateTime={picked.fetchedAt!} title={exactTime(picked.fetchedAt!)}>
                    {when(picked.fetchedAt!)}
                  </time>
                  . Lift it only if you know why it was contained.
                </>
              ) : (
                "Falcon doesn't report this device contained, so there is nothing to lift."
              )}
            </AlertDescription>
          </Alert>
        )}
        {contain.error && (
          <Alert variant="destructive">
            <AlertDescription>{contain.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!picked || !fresh(picked) || (lift && !isContained(picked)) || contain.isPending}
            onClick={() => contain.mutate()}
          >
            {lift ? "Lift containment" : "Contain host"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One device as Falcon reports it now, or why that isn't known yet. */
function DeviceFacts({ device: d }: { device: ContainmentDevice }) {
  return (
    <div className="grid gap-1 text-sm">
      <span className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium">{d.hostname ?? "Unknown hostname"}</span>
        {d.containment && (
          <Badge variant={d.containment === "normal" ? "secondary" : "outline"}>
            {containmentLabel[d.containment]}
          </Badge>
        )}
        <a
          href={d.consoleUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Open device ${d.deviceId} in the Falcon console`}
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLinkIcon aria-hidden className="size-3.5" />
        </a>
      </span>
      <span className="font-mono text-xs break-all text-muted-foreground">aid {d.deviceId}</span>
      {d.refreshing ? (
        <span className="text-muted-foreground">Fetching from Falcon…</span>
      ) : d.notFound ? (
        <span className="text-destructive">Falcon no longer knows this device.</span>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Platform</dt>
          <dd>{[d.platform, d.osVersion].filter(Boolean).join(" · ") || "—"}</dd>
          <dt className="text-muted-foreground">Host groups</dt>
          <dd>{d.hostGroups.length ? d.hostGroups.join(", ") : "None"}</dd>
          <dt className="text-muted-foreground">Last seen</dt>
          <dd>{d.lastSeen ? <time dateTime={d.lastSeen} title={exactTime(d.lastSeen)}>{when(d.lastSeen)}</time> : "—"}</dd>
          {d.fetchedAt && (
            <>
              <dt className="text-muted-foreground">As of</dt>
              <dd>
                <time dateTime={d.fetchedAt} title={exactTime(d.fetchedAt)}>
                  {when(d.fetchedAt)}
                </time>
              </dd>
            </>
          )}
        </dl>
      )}
      {d.error && <span className="text-xs text-destructive">Couldn't fetch it afresh: {d.error}</span>}
    </div>
  );
}
