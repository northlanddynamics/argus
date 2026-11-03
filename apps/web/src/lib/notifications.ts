import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Every query on the signed-in person's notifications starts with this key. */
export const notificationsKey = ["notifications"] as const;

export const notificationsQuery = queryOptions({
  queryKey: notificationsKey,
  queryFn: async () => {
    const res = await api.notifications.$get();
    if (!res.ok) throw new Error("Could not load your notifications");
    return res.json();
  },
});

export type Notifications = Awaited<ReturnType<typeof notificationsQuery.queryFn & {}>>;
export type Notification = Notifications["notifications"][number];

/** Marks one notification read; resolves with the list as it is now. */
export async function markRead(id: string) {
  const res = await api.notifications[":id"].read.$post({ param: { id } });
  if (!res.ok) throw new Error("Could not mark it read");
  return (await res.json()) as Notifications;
}

/** Marks every notification read; resolves with the list as it is now. */
export async function markAllRead() {
  const res = await api.notifications.read.$post();
  if (!res.ok) throw new Error("Could not mark them read");
  return res.json();
}
