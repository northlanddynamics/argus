import type { Deps } from "./deps";

export const inviteUrl = (baseUrl: string, invitationId: string) => `${baseUrl}/invite/${invitationId}`;

export async function sendOwnerInvite(
  { mailer, baseUrl }: Pick<Deps, "mailer" | "baseUrl">,
  invite: { invitationId: string; email: string; organizationName: string },
) {
  await mailer.send({
    to: invite.email,
    subject: `You're invited to own ${invite.organizationName} on Argus`,
    text: [
      `You have been invited to be the Owner of ${invite.organizationName} on Argus.`,
      "",
      `Accept the invitation and set your password: ${inviteUrl(baseUrl, invite.invitationId)}`,
      "",
      "The link expires in 7 days.",
    ].join("\n"),
  });
}
