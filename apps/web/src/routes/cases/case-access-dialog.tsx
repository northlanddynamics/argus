import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LockIcon, UsersIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { DatePicker, parseDay } from "@/components/date-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { type CaseView, caseRef } from "@/lib/cases";
import { expiryLabel, guestsKey, useGuests } from "@/lib/guests";

type InviteInput = { email: string; name?: string; expiresAt: string | null };

/**
 * Case page · Access: who can see the Case. Holds whether it is Restricted (hidden from Analysts
 * not on it), and its Guests: inviting them and removing them.
 */
export function CaseAccessDialog({
  c,
  locked,
  error,
  onRestrictedChange,
}: {
  c: CaseView;
  /** Restricted can't change now: the Case is Closed, or a change is on its way. */
  locked: boolean;
  /** Why the last change to Restricted failed. */
  error?: Error | null;
  onRestrictedChange: (restricted: boolean) => void;
}) {
  const number = c.number;
  const guests = useGuests(number, c.can.work);
  const count = guests.data?.length ?? 0;
  /** Lifting Restricted shows the Case to every Analyst, so it asks first. */
  const [confirmingUnrestrict, setConfirmingUnrestrict] = useState(false);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          {c.restricted ? <LockIcon data-icon="inline-start" /> : <UsersIcon data-icon="inline-start" />}
          Access
          {count > 0 && (
            <Badge variant="secondary" className="tabular-nums" aria-label={`${count} Guest${count === 1 ? "" : "s"}`}>
              {count}
            </Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Access to {caseRef(number)}</DialogTitle>
          <DialogDescription>Whether other Analysts can see this Case, and who from outside the Organization is on it.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field orientation="horizontal" data-disabled={locked || !c.can.restrict}>
            <Checkbox
              id="case-restricted"
              checked={c.restricted}
              disabled={locked || !c.can.restrict}
              onCheckedChange={(checked) => (checked === true ? onRestrictedChange(true) : setConfirmingUnrestrict(true))}
            />
            <FieldContent>
              <FieldLabel htmlFor="case-restricted">Restricted</FieldLabel>
              <FieldDescription>
                Only Admins, its Assignee and people with a Case Role on it can see it.
                {!c.can.restrict && " Only Admins and its Assignee can change this."}
              </FieldDescription>
            </FieldContent>
          </Field>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
          <AlertDialog open={confirmingUnrestrict} onOpenChange={setConfirmingUnrestrict}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Lift Restricted on {caseRef(number)}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every Analyst in the Organization will be able to see this Case and everything on it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it Restricted</AlertDialogCancel>
                <AlertDialogAction onClick={() => onRestrictedChange(false)}>Lift Restricted</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {c.can.work && (
            <>
              <FieldSeparator />
              <GuestsSection c={c} guests={guests} />
            </>
          )}
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}

/** The Case's Guests, removing them, and inviting more: email, optional name and optional expiry date. */
function GuestsSection({ c, guests }: { c: CaseView; guests: ReturnType<typeof useGuests> }) {
  const queryClient = useQueryClient();
  const number = c.number;
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  /** Access ends as this day ends; none means it never expires. */
  const [expiresOn, setExpiresOn] = useState("");
  /** Days before this one can't be picked. */
  const [today] = useState(() => new Date());

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.cases[":number"].guests[":id"].$delete({ param: { number: String(number), id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not remove the Guest"));
      const body = await res.json();
      return "guests" in body ? body.guests : [];
    },
    onSuccess: (next) => queryClient.setQueryData(guestsKey(number), next),
  });

  const invite = useMutation({
    mutationFn: async (json: InviteInput) => {
      const res = await api.cases[":number"].guests.$post({ param: { number: String(number) }, json });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not invite the Guest"));
      const body = await res.json();
      return "guests" in body ? body.guests : [];
    },
    onSuccess: (next) => {
      queryClient.setQueryData(guestsKey(number), next);
      setEmail("");
      setName("");
      setExpiresOn("");
    },
  });

  const onInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const until = parseDay(expiresOn);
    invite.mutate({
      email,
      ...(name.trim() && { name: name.trim() }),
      expiresAt: until ? new Date(until.getFullYear(), until.getMonth(), until.getDate(), 23, 59, 59).toISOString() : null,
    });
  };

  const canInvite = c.can.manageGuests && c.status !== "closed";
  const error = guests.error ?? remove.error;
  return (
    <FieldSet>
      <FieldLegend>Guests</FieldLegend>
      <FieldDescription>
        People outside the Organization. They sign in with a magic link and see only the Cases they're invited to, never the
        Audit Log, linked Cases they aren't on, or other Cases. Sessions last about 12 hours.
      </FieldDescription>
      {guests.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : guests.data?.length ? (
        <ul className="grid gap-2 text-sm" aria-label="Guests">
          {guests.data.map((g) => (
            <li key={g.id} className="flex items-start justify-between gap-2 rounded-lg border p-2.5">
              <span className="grid">
                <span>
                  {g.guest.name} {g.expired && <Badge variant="outline">Expired</Badge>}
                </span>
                <span className="text-xs text-muted-foreground">{g.guest.email}</span>
                <span className="text-xs text-muted-foreground">Access {expiryLabel(g.expiresAt)}</span>
              </span>
              {c.can.manageGuests && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" aria-label={`Remove ${g.guest.name}`} disabled={remove.isPending}>
                      Remove
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {g.guest.name} from {caseRef(number)}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        They lose access to this Case straight away. Everything they added stays on it. To let them back in, invite them
                        again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep {g.guest.name}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => remove.mutate(g.id)}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No Guests on this Case.</p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {canInvite ? (
        <form className="grid gap-4 rounded-lg bg-muted/50 p-3" onSubmit={onInvite} aria-label="Invite a Guest">
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="guest-email">Email</FieldLabel>
              <Input id="guest-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="guest-name">Name (optional)</FieldLabel>
                <Input id="guest-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="guest-expires">Access expires (optional)</FieldLabel>
                <DatePicker id="guest-expires" value={expiresOn} onChange={setExpiresOn} placeholder="Never" disabled={{ before: today }} />
              </Field>
            </div>
          </FieldGroup>
          {invite.error && (
            <Alert variant="destructive">
              <AlertDescription>{invite.error.message}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={invite.isPending}>
              Send invite
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">
          {c.status === "closed" ? "A Closed Case takes no new Guests." : "Only Admins and this Case's Assignee can invite or remove Guests."}
        </p>
      )}
    </FieldSet>
  );
}
