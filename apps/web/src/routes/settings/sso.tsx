import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";

const ssoKey = ["sso"] as const;

/** Throws the API's error message unless `res` is OK. */
async function ok(res: Response, fallback: string) {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
}

/** A value to copy into the identity provider, with its label. */
function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <code className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">{value}</code>
    </div>
  );
}

/** Settings · Single sign-on: the Organization's SAML connection to its identity provider. */
export function SsoPage() {
  const queryClient = useQueryClient();
  const sso = useQuery({
    queryKey: ssoKey,
    queryFn: async () => {
      const res = await api.sso.$get();
      if (!res.ok) throw new Error(await errorMessage(res, "Could not load single sign-on"));
      return (await res.json()).sso;
    },
  });
  const config = sso.data?.config ?? null;
  const [idpMode, setIdpMode] = useState<"metadata" | "manual">("metadata");
  const [domain, setDomain] = useState<string | null>(null);
  const [metadataXml, setMetadataXml] = useState("");
  const [entityId, setEntityId] = useState("");
  const [ssoUrl, setSsoUrl] = useState("");
  const [certificate, setCertificate] = useState("");
  const [provision, setProvision] = useState<boolean | null>(null);

  const domainValue = domain ?? config?.domain ?? "";
  const provisionValue = provision ?? config?.provisionAnalysts ?? false;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ssoKey });
  const idpGiven = idpMode === "metadata" ? !!metadataXml.trim() : !!(entityId.trim() && ssoUrl.trim() && certificate.trim());

  const save = useMutation({
    mutationFn: async () => {
      const idp = !idpGiven ? undefined : idpMode === "metadata" ? { metadataXml } : { entityId, ssoUrl, certificate };
      await ok(await api.sso.$put({ json: { domain: domainValue, idp, provisionAnalysts: provisionValue } }), "Could not save single sign-on");
    },
    onSuccess: async () => {
      setMetadataXml("");
      setCertificate("");
      setDomain(null);
      setProvision(null);
      await refresh();
    },
  });
  const disable = useMutation({
    mutationFn: async () => ok(await api.sso.$delete(), "Could not disable single sign-on"),
    onSuccess: refresh,
  });

  const enabled = sso.data?.enabled ?? false;
  const error = save.error ?? disable.error ?? sso.error;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };
  const sp = sso.data && "serviceProvider" in sso.data ? sso.data.serviceProvider : null;

  return (
    // `contents`: the header and the card stay direct children of the settings column's grid.
    <div data-testid="sso" className="contents">
      <PageHeader
        title="Single sign-on"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={enabled ? "default" : "outline"}>{enabled ? "Enabled" : "Not enabled"}</Badge>
            The Organization's SAML connection to its identity provider.
          </span>
        }
        actions={
          enabled && (
            <Button variant="outline" size="sm" disabled={disable.isPending} onClick={() => disable.mutate()}>
              Disable SSO
            </Button>
          )
        }
      />
      <Card>
        <CardContent>
          <form className="grid gap-5" onSubmit={onSubmit}>
            {sp && (
              <div className="grid gap-3">
                <p className="text-sm">Set up Argus as an application in your identity provider with:</p>
                <CopyValue label="Entity ID (audience)" value={sp.entityId} />
                <CopyValue label="Assertion consumer service (ACS) URL" value={sp.acsUrl} />
                <p className="text-sm text-muted-foreground">
                  Send the person's email as the NameID (or an <span className="font-mono">email</span> attribute), and sign assertions.{" "}
                  <a className="text-primary underline" href={sp.metadataUrl} target="_blank" rel="noreferrer">
                    Argus's SAML metadata
                  </a>
                </p>
              </div>
            )}
            {config && (
              <p className="text-sm text-muted-foreground">
                Identity provider <span className="font-mono">{config.idp.entityId}</span>, set by {config.updatedBy.name} on{" "}
                {new Date(config.updatedAt).toLocaleDateString()}
              </p>
            )}

            <div className="grid gap-2">
              <Label htmlFor="sso-domain">Email domain</Label>
              <Input id="sso-domain" placeholder="example.com" autoComplete="off" value={domainValue} onChange={(e) => setDomain(e.target.value)} />
              <p className="text-sm text-muted-foreground">People who sign in with SSO using an address at this domain go to your identity provider.</p>
            </div>

            <div className="grid gap-2">
              <span className="text-sm font-medium">{config ? "Replace the identity provider (optional)" : "Identity provider"}</span>
              <Tabs value={idpMode} onValueChange={(v) => setIdpMode(v as "metadata" | "manual")}>
                <TabsList>
                  <TabsTrigger value="metadata">Metadata XML</TabsTrigger>
                  <TabsTrigger value="manual">Enter by hand</TabsTrigger>
                </TabsList>
                <TabsContent value="metadata" className="grid gap-2 pt-2">
                  <Label htmlFor="sso-metadata">IdP metadata XML</Label>
                  <Textarea
                    id="sso-metadata"
                    className="min-h-32 font-mono text-xs"
                    placeholder={'<EntityDescriptor entityID="https://idp.example/…">…'}
                    value={metadataXml}
                    onChange={(e) => setMetadataXml(e.target.value)}
                  />
                </TabsContent>
                <TabsContent value="manual" className="grid gap-3 pt-2">
                  <div className="grid gap-2">
                    <Label htmlFor="sso-entity-id">IdP entity ID (issuer)</Label>
                    <Input id="sso-entity-id" autoComplete="off" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="sso-url">IdP sign-in URL</Label>
                    <Input id="sso-url" type="url" autoComplete="off" placeholder="https://idp.example/sso/saml" value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="sso-cert">IdP signing certificate</Label>
                    <Textarea
                      id="sso-cert"
                      className="min-h-24 font-mono text-xs"
                      placeholder="-----BEGIN CERTIFICATE-----"
                      value={certificate}
                      onChange={(e) => setCertificate(e.target.value)}
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </div>

            <Field orientation="horizontal">
              <Checkbox id="sso-provision" checked={provisionValue} onCheckedChange={(checked) => setProvision(checked === true)} />
              <FieldContent>
                <FieldLabel htmlFor="sso-provision">Provision unknown SSO users as Analysts</FieldLabel>
                <FieldDescription>
                  Someone your identity provider signs in who isn't a Member yet joins as an Analyst, if their email is at the domain above.
                  Otherwise only Members, and people with a pending invitation, get in.
                </FieldDescription>
              </FieldContent>
            </Field>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending || !domainValue.trim() || (!idpGiven && !config)}>
                {enabled ? "Save" : "Enable SSO"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
