import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, errorMessage, type Me } from "@/lib/api";

export type GuestInfo = NonNullable<Me["guest"]>;
export type GuestCase = GuestInfo["cases"][number];

/** "11 h 40 m": how long until `iso`. */
export function timeLeft(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} m` : `${minutes} m`;
}

/** "until 1 Dec 2026" or "no expiry". */
export const expiryLabel = (expiresAt: string | null) => (expiresAt ? `until ${new Date(expiresAt).toLocaleDateString()}` : "no expiry");

/**
 * Opens one of the Guest's Cases: switches to its Organization first when it's another one, since
 * Case numbers are per Organization.
 */
export function useOpenGuestCase(guest: GuestInfo) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (c: GuestCase) => {
    if (c.organization.id !== guest.organization?.id) {
      const res = await api.me.organization.$put({ json: { organizationId: c.organization.id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not open that Case"));
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    }
    await navigate({ to: "/cases/$number", params: { number: String(c.number) } });
  };
}
