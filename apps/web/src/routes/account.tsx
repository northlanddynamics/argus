import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Time } from "@/components/time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRemoveVirustotalKey, useSetVirustotalKey, virustotalKeyQuery } from "@/lib/hash-lookups";

/** Your settings: what a Member sets for themselves alone. */
export function AccountPage() {
  return (
    <div className="grid w-full max-w-3xl content-start gap-4">
      <h1 className="text-2xl font-semibold">Your settings</h1>
      <VirustotalKeyCard />
    </div>
  );
}

/**
 * The Member's own VirusTotal API key (ADR 0011): set, replaced or removed here, by them alone. Only
 * its last four characters are ever shown back.
 */
function VirustotalKeyCard() {
  const key = useQuery(virustotalKeyQuery);
  const set = useSetVirustotalKey();
  const remove = useRemoveVirustotalKey();
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const current = key.data ?? null;
  const editing = !current || replacing;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    set.mutate(apiKey.trim(), {
      onSuccess: () => {
        setApiKey("");
        setReplacing(false);
      },
    });
  };
  const error = set.error ?? remove.error ?? key.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>VirusTotal</CardTitle>
        <CardDescription>
          Hovering a hash anywhere in Argus shows what VirusTotal knows about the file, looked up with your own API key. What you look up is
          kept for your Organization for a day, so other Members see it without spending their quota; your key is never shown to anyone,
          Admins included.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {current && (
          <div className="grid gap-1">
            <p>
              API key <span className="font-mono">{current.hint}</span> · set <Time iso={current.updatedAt} />
              {current.lastUsedAt && (
                <span className="text-muted-foreground">
                  {" "}
                  · last used <Time iso={current.lastUsedAt} />
                </span>
              )}
            </p>
            {current.error && (
              <p className="rounded-md border border-notice-border bg-notice px-2 py-1.5 text-notice-foreground">
                {current.error}
                {current.errorAt && (
                  <>
                    {" "}
                    · <Time iso={current.errorAt} />
                  </>
                )}
              </p>
            )}
          </div>
        )}
        {editing ? (
          <form className="grid gap-3" onSubmit={onSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="virustotal-key">{current ? "New API key" : "API key"}</Label>
              <Input
                id="virustotal-key"
                type="password"
                required
                minLength={16}
                maxLength={200}
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Find it in your VirusTotal account, under API key. Argus checks it with VirusTotal before saving it.</p>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={set.isPending || !apiKey.trim()}>
                {set.isPending ? "Checking…" : "Save key"}
              </Button>
              {replacing && (
                <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
              Replace key
            </Button>
            <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Remove key
            </Button>
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
