import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Under the Case's key, so its live signal refreshes them. */
export const tasksKey = (number: number) => ["cases", number, "tasks"] as const;

export const tasksQuery = (number: number) =>
  queryOptions({
    queryKey: tasksKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].tasks.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Tasks");
      return (await res.json()).tasks;
    },
  });

export type TaskView = NonNullable<Awaited<ReturnType<ReturnType<typeof tasksQuery>["queryFn"] & {}>>>[number];

/** Overdue first, then by due date (none last), then as listed. */
export const byUrgency = (a: TaskView, b: TaskView) =>
  Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
