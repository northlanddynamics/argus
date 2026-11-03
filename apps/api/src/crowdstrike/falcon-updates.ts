import type { StreamEvent } from "./falcon";

/**
 * Changes made to Alerts in the Falcon console, as the stream reports them (ADR 0002): a
 * `UserActivityAuditEvent` with `OperationName=detection_update`, naming the Alerts by composite ID
 * and what changed in `AuditKeyValues`.
 */

/** What one Falcon user changed on one or more Alerts, and when. Fields left undefined were not changed. */
export type FalconUpdate = {
  externalIds: string[];
  /** When the change was made in Falcon: what last-write-wins compares. */
  at: Date;
  /** The Falcon user who made it, if the event says. */
  user: string | null;
  status?: string;
  /** null: unassigned. */
  assignee?: string | null;
  tags?: { set: string[] | null; add: string[]; remove: string[] };
};

const ID_KEYS = ["composite_id", "composite_ids", "detection_id", "detection_ids", "alert_id", "CompositeId"];
const STATUS_KEYS = ["new_status", "status", "update_status"];
const ASSIGNEE_KEYS = ["assigned_to_name", "assigned_to_user_name", "assigned_to_uuid", "assigned_to_uid", "assigned_to", "new_assignee"];
const UNASSIGN_KEYS = ["unassign", "unassigned"];
const TAGS_KEYS = ["tags", "new_tags"];
const ADD_TAG_KEYS = ["add_tag", "add_tags", "tag_added"];
const REMOVE_TAG_KEYS = ["remove_tag", "remove_tags", "tag_removed"];

/** `AuditKeyValues` as key → every value given for it, in order. */
function keyValues(event: Record<string, unknown>) {
  const values = new Map<string, string[]>();
  const list = event.AuditKeyValues;
  if (!Array.isArray(list)) return values;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { Key, ValueString } = item as { Key?: unknown; ValueString?: unknown };
    if (typeof Key !== "string") continue;
    const value = typeof ValueString === "string" ? ValueString.trim() : "";
    values.set(Key, [...(values.get(Key) ?? []), value]);
  }
  return values;
}

/** Splits comma-separated lists, dropping blanks. */
const items = (values: readonly string[]) => values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

const first = (values: Map<string, string[]>, keys: readonly string[]) => {
  for (const key of keys) if (values.has(key)) return values.get(key)!;
  return undefined;
};

/** Falcon's `UTCTimestamp`, in seconds or milliseconds. */
function timestamp(value: unknown) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e12 ? n : n * 1000);
}

/** The Falcon change an event reports, or null if it isn't a `detection_update` naming an Alert. */
export function readFalconUpdate({ eventType, event, createdAt }: StreamEvent, now: Date): FalconUpdate | null {
  if (eventType !== "UserActivityAuditEvent" || event.OperationName !== "detection_update") return null;
  const values = keyValues(event);
  const externalIds = [...new Set(items(ID_KEYS.flatMap((k) => values.get(k) ?? [])))];
  if (!externalIds.length) return null;

  const update: FalconUpdate = {
    externalIds,
    at: timestamp(event.UTCTimestamp) ?? createdAt ?? now,
    user: typeof event.UserId === "string" && event.UserId.trim() ? event.UserId.trim() : null,
  };
  const status = first(values, STATUS_KEYS)?.at(-1);
  if (status) update.status = status.toLowerCase();
  const assignee = first(values, ASSIGNEE_KEYS);
  if (assignee) update.assignee = assignee.at(-1) || null;
  else if (first(values, UNASSIGN_KEYS)) update.assignee = null;
  const set = first(values, TAGS_KEYS);
  const add = items(ADD_TAG_KEYS.flatMap((k) => values.get(k) ?? []));
  const remove = items(REMOVE_TAG_KEYS.flatMap((k) => values.get(k) ?? []));
  if (set || add.length || remove.length) update.tags = { set: set ? items(set) : null, add, remove };
  return update;
}
