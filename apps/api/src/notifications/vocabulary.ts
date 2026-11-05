/** Why someone was notified. Shared by the API and the SPA. */
export const NOTIFICATION_KINDS = [
  /** Made Assignee of a Case. */
  "case_assigned",
  /** Made owner of a Task. */
  "task_assigned",
  /** @mentioned in a Discussion message. */
  "mentioned",
  /** A Guest was added to a Case you are Assignee of. */
  "guest_added",
  /** A Case you take part in had its Severity raised to Critical. */
  "severity_critical",
  /** A Task you own is overdue. */
  "task_overdue",
  /** A Response Action you took failed after its retries. */
  "response_action_failed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
