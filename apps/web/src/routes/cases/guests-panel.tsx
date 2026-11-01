import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { type CaseView, caseKey, caseRef } from "@/lib/cases";
import { expiryLabel } from "@/lib/guests";

const guestsKey = (number: number) => [...caseKey(number), "guests"] as const;

type InviteInput = { email: string; name?: string; expiresAt: string | null };

/** Case page · Guests: who from outside the Organization is on the Case, inviting and removing them. */
export function GuestsPanel({ c }: { c: CaseView }) {
  const queryClient = useQueryClient();
  const number = c.number;
  const guests = useQuery({
    queryKey: guestsKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].guests.$get({ param: { number: String(number) } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not load the Guests"));
      const body = await res.json();
      return "guests" in body ? body.guests : [];
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.cases[":number"].guests[":id"].$delete({ param: { number: String(number), id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not remove the Guest"));
      const body = await res.json();
      return "guests" in body ? body.guests : [];
    },
    onSuccess: (next) => queryClient.setQueryData(guestsKey(number), next),
  });

  const canInvite = c.can.manageGuests && c.status !== "closed";
  return (
    <Card className="self-start">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-xs tracking-widest text-muted-foreground uppercase">Guests</CardTitle>
        {canInvite && <InviteGuestDialog number={number} />}
      </CardHeader>
      <CardContent className="grid gap-3">
        {guests.data?.length ? (
          <ul className="grid gap-2 text-sm">
            {guests.data.map((g) => (
              <li key={g.id} className="flex items-start justify-between gap-2">
                <span className="grid">
                  <span>
                    {g.guest.name} {g.expired && <Badge variant="outline">Expired</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">{g.guest.email}</span>
                  <span className="text-xs text-muted-foreground">Access {expiryLabel(g.expiresAt)}</span>
                </span>
                {c.can.manageGuests && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${g.guest.name}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(g.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{guests.isPending ? "Loading…" : "No Guests on this Case."}</p>
        )}
        {(guests.error ?? remove.error) && (
          <Alert variant="destructive">
            <AlertDescription>{(guests.error ?? remove.error)?.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/** "+ Invite": email, optional name and optional expiry date (access ends as that day ends). */
function InviteGuestDialog({ number }: { number: number }) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const invite = useMutation({
    mutationFn: async (json: InviteInput) => {
      const res = await api.cases[":number"].guests.$post({ param: { number: String(number) }, json });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not invite the Guest"));
      const body = await res.json();
      return "guests" in body ? body.guests : [];
    },
    onSuccess: (next) => {
      queryClient.setQueryData(guestsKey(number), next);
      setIsOpen(false);
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const until = String(form.get("expiresOn") ?? "");
    const name = String(form.get("name") ?? "").trim();
    invite.mutate({
      email: String(form.get("email")),
      ...(name && { name }),
      expiresAt: until ? new Date(`${until}T23:59:59`).toISOString() : null,
    });
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) invite.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          + Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a Guest to {caseRef(number)}</DialogTitle>
          <DialogDescription>
            They sign in with a magic link and see only the Cases they're invited to, never the Audit Log, linked Cases they
            aren't on, or other Cases. Sessions last about 12 hours.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="guest-email">Email</Label>
            <Input id="guest-email" name="email" type="email" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="guest-name">Name (optional)</Label>
            <Input id="guest-name" name="name" maxLength={200} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="guest-expires">Access expires (optional)</Label>
            <Input id="guest-expires" name="expiresOn" type="date" />
          </div>
          <p className="text-xs text-muted-foreground">Only Admins and this Case's Assignee can invite or remove Guests.</p>
          {invite.error && (
            <Alert variant="destructive">
              <AlertDescription>{invite.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={invite.isPending}>
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
