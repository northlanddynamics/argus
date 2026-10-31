import type { OrgRole } from "../auth/roles";
import type { Deps } from "../deps";

export const inviteUrl = (baseUrl: string, invitationId: string) => `${baseUrl}/invite/${invitationId}`;

/** Invitations last 7 days. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const roleNames: Record<OrgRole, string> = { owner: "Owner", admin: "an Admin", analyst: "an Analyst" };

export async function sendInvite(
  { mailer, baseUrl }: Pick<Deps, "mailer" | "baseUrl">,
  invite: { invitationId: string; email: string; organizationName: string; role: OrgRole },
) {
  const isOwner = invite.role === "owner";
  await mailer.send({
    to: invite.email,
    subject: isOwner
      ? `You're invited to own ${invite.organizationName} on Argus`
      : `You're invited to join ${invite.organizationName} on Argus`,
    text: [
      isOwner
        ? `You have been invited to be the Owner of ${invite.organizationName} on Argus.`
        : `You have been invited to join ${invite.organizationName} on Argus as ${roleNames[invite.role]}.`,
      "",
      `Accept the invitation and set your password: ${inviteUrl(baseUrl, invite.invitationId)}`,
      "",
      "The link expires in 7 days.",
    ].join("\n"),
  });
}
