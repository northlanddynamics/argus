/**
 * Members must use TOTP with their password (#3). Better Auth's `twoFactor` plugin
 * challenges for a code at sign-in only once TOTP is enabled, so a Member who hasn't
 * enrolled yet gets a session from their password alone. That session is held to the
 * enrollment endpoints until TOTP is confirmed: it reaches nothing else in Argus.
 */

export const TOTP_ENROLLMENT_REQUIRED = "TOTP_ENROLLMENT_REQUIRED";

/** Better Auth endpoints a session awaiting TOTP enrollment may still call. */
export const TOTP_ENROLLMENT_PATHS = new Set([
  "/get-session",
  "/sign-out",
  // Signing in again replaces the session rather than using it.
  "/sign-in/email",
  "/sign-in/passkey",
  "/passkey/generate-authenticate-options",
  "/two-factor/enable",
  "/two-factor/verify-totp",
]);

type SessionLike = { user: Record<string, unknown>; session: Record<string, unknown> };

/**
 * A Member (the session carries their Organization) whose TOTP isn't confirmed.
 * Members can only register a passkey from a full session, so a passkey session
 * always belongs to a Member who has already enrolled.
 */
export const totpEnrollmentPending = ({ user, session }: SessionLike) =>
  !!session.activeOrganizationId && !user.twoFactorEnabled;
