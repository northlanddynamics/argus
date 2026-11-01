import type { Deps } from "../deps";
import { caseRef } from "../cases/vocabulary";

/** Where a Guest asks for a magic link. */
export const guestSignInUrl = (baseUrl: string, email: string) => `${baseUrl}/guest/sign-in?email=${encodeURIComponent(email)}`;

/** Tells a Guest they have been let into a Case, and how to sign in. */
export async function sendGuestInvite(
  { mailer, baseUrl }: Pick<Deps, "mailer" | "baseUrl">,
  invite: { email: string; organizationName: string; number: number; title: string; invitedBy: string; expiresAt: Date | null },
) {
  await mailer.send({
    to: invite.email,
    subject: `You're invited to ${caseRef(invite.number)} at ${invite.organizationName} on Argus`,
    text: [
      `${invite.invitedBy} invited you to work on ${caseRef(invite.number)} · ${invite.title} at ${invite.organizationName}, as a Guest.`,
      "",
      `Sign in with a link we email you: ${guestSignInUrl(baseUrl, invite.email)}`,
      "",
      invite.expiresAt ? `Your access ends ${invite.expiresAt.toISOString()}.` : "Your access lasts until you are removed from the Case.",
    ].join("\n"),
  });
}
