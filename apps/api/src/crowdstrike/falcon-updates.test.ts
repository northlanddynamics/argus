import { describe, expect, test } from "bun:test";
import { readFalconUpdate } from "./falcon-updates";

const now = new Date("2026-11-03T12:00:00Z");
const audit = (values: [string, string][], extra: Record<string, unknown> = {}) => ({
  offset: 1,
  eventType: "UserActivityAuditEvent",
  createdAt: new Date("2026-11-03T11:00:00Z"),
  event: { OperationName: "detection_update", UserId: "jsmith", AuditKeyValues: values.map(([Key, ValueString]) => ({ Key, ValueString })), ...extra },
});

describe("Reading a detection_update", () => {
  test("names the Alerts by composite ID and what changed", () => {
    const update = readFalconUpdate(
      audit([["detection_id", "ldt:1,ldt:2"], ["status", "In_Progress"], ["assigned_to_name", "John Smith"], ["add_tag", "a, b"], ["remove_tag", "c"]], { UTCTimestamp: 1_800_000_000 }),
      now,
    );
    expect(update).toEqual({
      externalIds: ["ldt:1", "ldt:2"],
      at: new Date(1_800_000_000_000),
      user: "jsmith",
      status: "in_progress",
      assignee: "John Smith",
      tags: { set: null, add: ["a", "b"], remove: ["c"] },
    });
  });

  test("takes milliseconds too, and falls back to the event's creation time", () => {
    expect(readFalconUpdate(audit([["composite_id", "ldt:1"]], { UTCTimestamp: 1_800_000_000_123 }), now)?.at).toEqual(new Date(1_800_000_000_123));
    expect(readFalconUpdate(audit([["composite_id", "ldt:1"]]), now)?.at).toEqual(new Date("2026-11-03T11:00:00Z"));
  });

  test("an empty assignee unassigns; leaves out what didn't change", () => {
    const update = readFalconUpdate(audit([["composite_id", "ldt:1"], ["assigned_to_name", ""]]), now);
    expect(update?.assignee).toBeNull();
    expect(update && "status" in update).toBe(false);
    expect(update?.tags).toBeUndefined();
  });

  test("ignores other operations, other events and events naming no Alert", () => {
    expect(readFalconUpdate({ ...audit([["composite_id", "ldt:1"]]), event: { OperationName: "detection_containment" } }, now)).toBeNull();
    expect(readFalconUpdate({ ...audit([["composite_id", "ldt:1"]]), eventType: "EppDetectionSummaryEvent" }, now)).toBeNull();
    expect(readFalconUpdate(audit([["status", "closed"]]), now)).toBeNull();
  });
});
