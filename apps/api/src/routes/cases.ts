import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { caseSummarySchema } from "../cases/case-summary";
import {
  AssignmentNotFound,
  CaseRoleNotFound,
  CaseRoleRetired,
  NotAMember as CaseRoleNotForMember,
} from "../case-roles/case-roles";
import { CaseClosed, CaseNotClosed, CaseNotFound, NotAMember, NotPermitted, StaleSummary } from "../cases/cases";
import { CASE_AUDIT_ACTIONS, CASE_TYPES, RESOLUTIONS, SEVERITIES, STATUSES } from "../cases/vocabulary";
import type { Deps } from "../deps";
import { MentionCannotSeeCase, MessageNotFound, MessageRetracted } from "../discussion/discussion";
import { type EvidenceAccess, EvidenceEmpty, EvidenceNotFound, EvidenceTooLarge } from "../evidence/evidence";
import { type MemberEnv, requireMember } from "../members/membership";
import { InvalidValue, NotLinked } from "../observables/observables";
import { ASSET_TYPES, OBSERVABLE_TYPES } from "../observables/vocabulary";
import type { Modules } from "../modules";
import { OwnerCannotSeeCase, StaleTask, TaskNotFound } from "../tasks/tasks";
import {
  AlreadyPromoted,
  CitationNotFound,
  SourceNotFound,
  SourceRetracted,
  StaleTimelineEntry,
  TimelineEntryNotFound,
  TimelineEntryRetracted,
} from "../timeline/timeline";
import { CITATION_KINDS, PROMOTION_SOURCES } from "../timeline/vocabulary";
import { downloadHeaders, mediaType, viewHeaders } from "./evidence-http";

const numberParam = z.object({ number: z.coerce.number().int().positive() });
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Not a date");

const openBody = z.object({
  title: z.string().trim().min(1).max(300),
  caseType: z.enum(CASE_TYPES),
  severity: z.enum(SEVERITIES),
  summary: caseSummarySchema.optional(),
});

const listQuery = z.object({
  view: z.enum(["open", "mine", "unassigned", "closed"]).optional(),
  status: z.enum(STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  caseType: z.enum(CASE_TYPES).optional(),
});

const changeBody = z.object({
  // Closing records a Resolution, so it has its own route.
  status: z
    .enum(STATUSES)
    .refine((s) => s !== "closed", "Close a Case with a Resolution")
    .optional(),
  severity: z.enum(SEVERITIES).optional(),
  caseType: z.enum(CASE_TYPES).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  /** Admins, the Owner and the Assignee only. */
  restricted: z.boolean().optional(),
});

const closeBody = z.object({ resolution: z.enum(RESOLUTIONS) });

const summaryBody = z.object({ summary: caseSummarySchema, version: z.number().int().positive() });

const auditQuery = z.object({
  actor: z.string().min(1).optional(),
  action: z.enum(CASE_AUDIT_ACTIONS).optional(),
  from: isoDate.optional(),
});

const taskParam = numberParam.extend({ id: z.string().min(1) });
const assignmentParam = numberParam.extend({ assignmentId: z.string().min(1) });

/** A calendar date, YYYY-MM-DD. */
const dueDate = z.iso.date();
const taskTitle = z.string().trim().min(1).max(300);
const taskDescription = z.string().trim().max(10_000);

const newTaskBody = z.object({
  title: taskTitle,
  description: taskDescription.default(""),
  ownerId: z.string().min(1),
  dueDate: dueDate.nullable().default(null),
});

const taskEditBody = z.object({
  title: taskTitle.optional(),
  description: taskDescription.optional(),
  ownerId: z.string().min(1).optional(),
  dueDate: dueDate.nullable().optional(),
  version: z.number().int().positive(),
});

const doneBody = z.object({ done: z.boolean() });

const assignBody = z.object({ caseRoleId: z.string().min(1), userId: z.string().min(1) });

const messageParam = numberParam.extend({ id: z.string().min(1) });
/** Plain text; `<@userId>` mentions someone. */
const messageBody = z.object({ body: z.string().trim().min(1).max(10_000) });

const instant = z.iso.datetime({ offset: true });
/** Up to a year either way. */
const precisionMinutes = z.number().int().positive().max(525_600);
const occurredAt = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), at: instant }),
  z
    .object({ kind: z.literal("range"), start: instant, end: instant })
    .refine((r) => Date.parse(r.end) > Date.parse(r.start), { message: "A range must end after it starts", path: ["end"] }),
  z.object({ kind: z.literal("approximate"), at: instant, precisionMinutes }),
]);
const timelineEntryFields = {
  occurredAt,
  body: z.string().trim().min(1).max(10_000),
  citations: z
    .array(z.object({ kind: z.enum(CITATION_KINDS), id: z.string().min(1) }))
    .max(50)
    .default([]),
};
const newTimelineEntryBody = z.object({
  ...timelineEntryFields,
  /** Promotes this Discussion message or Case Audit Log entry. */
  source: z.object({ kind: z.enum(PROMOTION_SOURCES), id: z.string().min(1) }).optional(),
});
const timelineEntryEditBody = z.object({ ...timelineEntryFields, version: z.number().int().positive() });
const retractEntryBody = z.object({ reason: z.string().trim().max(500).nullable().default(null) });
const entryParam = numberParam.extend({ id: z.string().min(1) });

const evidenceParam = numberParam.extend({ id: z.string().min(1) });
/** The file's own name; the file itself is the request body, so any size streams straight through. */
const evidenceQuery = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      (n) => ![...n].some((ch) => ch === "/" || ch === "\\" || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f),
      "A file name can't contain slashes or control characters",
    ),
});

const linkedParam = numberParam.extend({ id: z.string().min(1) });
/** Defanged values are accepted; the module normalises them. */
const observableBody = z.object({ type: z.enum(OBSERVABLE_TYPES), value: z.string().trim().min(1).max(2048) });
const assetBody = z.object({ type: z.enum(ASSET_TYPES), value: z.string().trim().min(1).max(300) });

const notFound = { error: "Case not found" } as const;

/** The result, or null if the Member can't see the Case (another Organization's, or Restricted). */
const unlessNotFound = <T>(work: Promise<T>) =>
  work.catch((e: unknown) => {
    if (e instanceof CaseNotFound) return null;
    throw e;
  });

/** Turns a refusal to change a Closed Case into the result it carries, and rethrows anything else. */
const closedConflict = (e: unknown) => {
  if (e instanceof CaseClosed || e instanceof CaseNotClosed) return { error: e.message };
  throw e;
};

/**
 * Cases: open, list, view, change, close, reopen, the Case Summary, Tasks, Case Role assignments, the
 * Discussion, the Timeline, Evidence, Observables and Assets, and the Case Audit Log.
 */
export const caseRoutes = (deps: Deps, { cases: store, tasks, caseRoles, discussion, timeline, evidence, observables, assets }: Modules) => {
  const origin = new URL(deps.baseUrl).origin;

  /** Streams Evidence to view or download, once its access is recorded. */
  const openEvidence = (access: EvidenceAccess) =>
    async function (c: Context<MemberEnv>, { number, id }: z.infer<typeof evidenceParam>) {
      try {
        const opened = await unlessNotFound(evidence.open(c.get("membership"), number, id, access));
        if (!opened) return c.json(notFound, 404);
        const headers = access === "view" ? viewHeaders(opened.evidence) : downloadHeaders(opened.evidence);
        return c.body(opened.body, 200, headers);
      } catch (e) {
        if (e instanceof EvidenceNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    };

  return new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .post("/", zValidator("json", openBody), async (c) => {
      const opened = await store.open(c.get("membership"), c.req.valid("json"));
      return c.json({ case: opened }, 201);
    })
    .get("/", zValidator("query", listQuery), async (c) => {
      return c.json(await store.list(c.get("membership"), c.req.valid("query")), 200);
    })
    .get("/:number", zValidator("param", numberParam), async (c) => {
      const found = await unlessNotFound(store.view(c.get("membership"), c.req.valid("param").number));
      if (!found) return c.json(notFound, 404);
      return c.json({ case: found }, 200);
    })
    .patch("/:number", zValidator("param", numberParam), zValidator("json", changeBody), async (c) => {
      try {
        const changed = await store.change(c.get("membership"), c.req.valid("param").number, c.req.valid("json"));
        // The change went through, but left the Member unable to see the Case.
        if (!changed) return c.json({ case: null }, 200);
        return c.json({ case: changed }, 200);
      } catch (e) {
        if (e instanceof CaseNotFound) return c.json(notFound, 404);
        if (e instanceof NotAMember) return c.json({ error: "The Assignee must be a Member of the Organization" }, 400);
        if (e instanceof NotPermitted) return c.json({ error: "Only an Admin or the Assignee can change whether a Case is Restricted" }, 403);
        return c.json(closedConflict(e), 409);
      }
    })
    .post("/:number/close", zValidator("param", numberParam), zValidator("json", closeBody), async (c) => {
      try {
        const closed = await unlessNotFound(store.close(c.get("membership"), c.req.valid("param").number, c.req.valid("json").resolution));
        if (!closed) return c.json(notFound, 404);
        return c.json({ case: closed }, 200);
      } catch (e) {
        return c.json(closedConflict(e), 409);
      }
    })
    .post("/:number/reopen", zValidator("param", numberParam), async (c) => {
      try {
        const reopened = await unlessNotFound(store.reopen(c.get("membership"), c.req.valid("param").number));
        if (!reopened) return c.json(notFound, 404);
        return c.json({ case: reopened }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: "Only an Admin can reopen a Case" }, 403);
        return c.json(closedConflict(e), 409);
      }
    })
    .put("/:number/summary", zValidator("param", numberParam), zValidator("json", summaryBody), async (c) => {
      const { summary, version } = c.req.valid("json");
      try {
        const saved = await unlessNotFound(store.saveSummary(c.get("membership"), c.req.valid("param").number, summary, version));
        if (!saved) return c.json(notFound, 404);
        return c.json({ summary: saved }, 200);
      } catch (e) {
        if (e instanceof StaleSummary) return c.json({ error: e.message, current: e.current }, 409);
        return c.json(closedConflict(e), 409);
      }
    })
    .get("/:number/tasks", zValidator("param", numberParam), async (c) => {
      const found = await unlessNotFound(tasks.list(c.get("membership"), c.req.valid("param").number));
      if (!found) return c.json(notFound, 404);
      return c.json({ tasks: found }, 200);
    })
    .post("/:number/tasks", zValidator("param", numberParam), zValidator("json", newTaskBody), async (c) => {
      try {
        const created = await unlessNotFound(tasks.create(c.get("membership"), c.req.valid("param").number, c.req.valid("json")));
        if (!created) return c.json(notFound, 404);
        return c.json({ task: created }, 201);
      } catch (e) {
        if (e instanceof OwnerCannotSeeCase) return c.json({ error: e.message }, 400);
        return c.json(closedConflict(e), 409);
      }
    })
    .patch("/:number/tasks/:id", zValidator("param", taskParam), zValidator("json", taskEditBody), async (c) => {
      const { number, id } = c.req.valid("param");
      const { version, ...changes } = c.req.valid("json");
      try {
        const edited = await unlessNotFound(tasks.edit(c.get("membership"), number, id, changes, version));
        if (!edited) return c.json(notFound, 404);
        return c.json({ task: edited }, 200);
      } catch (e) {
        if (e instanceof TaskNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof OwnerCannotSeeCase) return c.json({ error: e.message }, 400);
        if (e instanceof StaleTask) return c.json({ error: e.message, current: e.current }, 409);
        return c.json(closedConflict(e), 409);
      }
    })
    .put("/:number/tasks/:id/done", zValidator("param", taskParam), zValidator("json", doneBody), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const task = await unlessNotFound(tasks.setDone(c.get("membership"), number, id, c.req.valid("json").done));
        if (!task) return c.json(notFound, 404);
        return c.json({ task }, 200);
      } catch (e) {
        if (e instanceof TaskNotFound) return c.json({ error: e.message }, 404);
        return c.json(closedConflict(e), 409);
      }
    })
    .post("/:number/case-roles", zValidator("param", numberParam), zValidator("json", assignBody), async (c) => {
      try {
        const assignments = await unlessNotFound(caseRoles.assign(c.get("membership"), c.req.valid("param").number, c.req.valid("json")));
        if (!assignments) return c.json(notFound, 404);
        return c.json({ caseRoles: assignments }, 200);
      } catch (e) {
        if (e instanceof CaseRoleNotFound || e instanceof CaseRoleRetired || e instanceof CaseRoleNotForMember) {
          return c.json({ error: e.message }, 400);
        }
        return c.json(closedConflict(e), 409);
      }
    })
    .delete("/:number/case-roles/:assignmentId", zValidator("param", assignmentParam), async (c) => {
      const { number, assignmentId } = c.req.valid("param");
      try {
        const assignments = await caseRoles.unassign(c.get("membership"), number, assignmentId);
        // Taken away, but that left the Member unable to see the Case.
        return c.json({ caseRoles: assignments }, 200);
      } catch (e) {
        if (e instanceof CaseNotFound) return c.json(notFound, 404);
        if (e instanceof AssignmentNotFound) return c.json({ error: e.message }, 404);
        return c.json(closedConflict(e), 409);
      }
    })
    .get("/:number/discussion", zValidator("param", numberParam), async (c) => {
      const messages = await unlessNotFound(discussion.list(c.get("membership"), c.req.valid("param").number));
      if (!messages) return c.json(notFound, 404);
      return c.json({ messages }, 200);
    })
    .get("/:number/discussion/mentionable", zValidator("param", numberParam), async (c) => {
      const people = await unlessNotFound(discussion.mentionable(c.get("membership"), c.req.valid("param").number));
      if (!people) return c.json(notFound, 404);
      return c.json({ people }, 200);
    })
    .post("/:number/discussion", zValidator("param", numberParam), zValidator("json", messageBody), async (c) => {
      try {
        const message = await unlessNotFound(discussion.post(c.get("membership"), c.req.valid("param").number, c.req.valid("json").body));
        if (!message) return c.json(notFound, 404);
        return c.json({ message }, 201);
      } catch (e) {
        if (e instanceof MentionCannotSeeCase) return c.json({ error: e.message }, 400);
        return c.json(closedConflict(e), 409);
      }
    })
    .patch("/:number/discussion/:id", zValidator("param", messageParam), zValidator("json", messageBody), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const message = await unlessNotFound(discussion.edit(c.get("membership"), number, id, c.req.valid("json").body));
        if (!message) return c.json(notFound, 404);
        return c.json({ message }, 200);
      } catch (e) {
        if (e instanceof MessageNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotPermitted) return c.json({ error: "Only its author can edit a message" }, 403);
        if (e instanceof MentionCannotSeeCase) return c.json({ error: e.message }, 400);
        if (e instanceof MessageRetracted) return c.json({ error: e.message }, 409);
        return c.json(closedConflict(e), 409);
      }
    })
    .post("/:number/discussion/:id/retract", zValidator("param", messageParam), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const message = await unlessNotFound(discussion.retract(c.get("membership"), number, id));
        if (!message) return c.json(notFound, 404);
        return c.json({ message }, 200);
      } catch (e) {
        if (e instanceof MessageNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof NotPermitted) return c.json({ error: "Only its author can retract a message" }, 403);
        if (e instanceof MessageRetracted) return c.json({ error: e.message }, 409);
        return c.json(closedConflict(e), 409);
      }
    })
    .get("/:number/timeline", zValidator("param", numberParam), async (c) => {
      const entries = await unlessNotFound(timeline.list(c.get("membership"), c.req.valid("param").number));
      if (!entries) return c.json(notFound, 404);
      return c.json({ entries }, 200);
    })
    .post("/:number/timeline", zValidator("param", numberParam), zValidator("json", newTimelineEntryBody), async (c) => {
      const { source, ...input } = c.req.valid("json");
      try {
        const entry = await unlessNotFound(timeline.add(c.get("membership"), c.req.valid("param").number, input, source));
        if (!entry) return c.json(notFound, 404);
        return c.json({ entry }, 201);
      } catch (e) {
        if (e instanceof CitationNotFound || e instanceof SourceNotFound) return c.json({ error: e.message }, 400);
        if (e instanceof AlreadyPromoted) return c.json({ error: e.message, entryId: e.entryId }, 409);
        if (e instanceof SourceRetracted) return c.json({ error: e.message }, 409);
        return c.json(closedConflict(e), 409);
      }
    })
    .patch("/:number/timeline/:id", zValidator("param", entryParam), zValidator("json", timelineEntryEditBody), async (c) => {
      const { number, id } = c.req.valid("param");
      const { version, ...input } = c.req.valid("json");
      try {
        const entry = await unlessNotFound(timeline.edit(c.get("membership"), number, id, input, version));
        if (!entry) return c.json(notFound, 404);
        return c.json({ entry }, 200);
      } catch (e) {
        if (e instanceof TimelineEntryNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof CitationNotFound) return c.json({ error: e.message }, 400);
        if (e instanceof StaleTimelineEntry) return c.json({ error: e.message, current: e.current }, 409);
        if (e instanceof TimelineEntryRetracted) return c.json({ error: e.message }, 409);
        return c.json(closedConflict(e), 409);
      }
    })
    .post("/:number/timeline/:id/retract", zValidator("param", entryParam), zValidator("json", retractEntryBody), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const entry = await unlessNotFound(timeline.retract(c.get("membership"), number, id, c.req.valid("json").reason || null));
        if (!entry) return c.json(notFound, 404);
        return c.json({ entry }, 200);
      } catch (e) {
        if (e instanceof TimelineEntryNotFound) return c.json({ error: e.message }, 404);
        if (e instanceof TimelineEntryRetracted) return c.json({ error: e.message }, 409);
        return c.json(closedConflict(e), 409);
      }
    })
    .get("/:number/evidence", zValidator("param", numberParam), async (c) => {
      const files = await unlessNotFound(evidence.list(c.get("membership"), c.req.valid("param").number));
      if (!files) return c.json(notFound, 404);
      return c.json({ evidence: files }, 200);
    })
    .post("/:number/evidence", zValidator("param", numberParam), zValidator("query", evidenceQuery), async (c) => {
      // The body isn't JSON, so a cross-site form could send it; only our own pages may.
      if (c.req.header("origin") !== origin) return c.json({ error: "Cross-origin uploads are not allowed" }, 403);
      const declared = Number(c.req.header("content-length"));
      if (declared > deps.evidence.maxBytes) return c.json({ error: new EvidenceTooLarge(deps.evidence.maxBytes).message }, 413);
      const body = c.req.raw.body;
      if (!body) return c.json({ error: new EvidenceEmpty().message }, 400);
      try {
        const added = await unlessNotFound(
          evidence.add(c.get("membership"), c.req.valid("param").number, {
            name: c.req.valid("query").name,
            contentType: mediaType(c.req.header("content-type")),
            body,
          }),
        );
        if (!added) return c.json(notFound, 404);
        return c.json({ evidence: added }, 201);
      } catch (e) {
        if (e instanceof EvidenceTooLarge) return c.json({ error: e.message }, 413);
        if (e instanceof EvidenceEmpty) return c.json({ error: e.message }, 400);
        return c.json(closedConflict(e), 409);
      }
    })
    .get("/:number/evidence/:id/view", zValidator("param", evidenceParam), (c) => openEvidence("view")(c, c.req.valid("param")))
    .get("/:number/evidence/:id/download", zValidator("param", evidenceParam), (c) =>
      openEvidence("download")(c, c.req.valid("param")),
    )
    .get("/:number/observables", zValidator("param", numberParam), async (c) => {
      const linked = await unlessNotFound(observables.list(c.get("membership"), c.req.valid("param").number));
      if (!linked) return c.json(notFound, 404);
      return c.json({ observables: linked }, 200);
    })
    .post("/:number/observables", zValidator("param", numberParam), zValidator("json", observableBody), async (c) => {
      const { type, value } = c.req.valid("json");
      try {
        const done = await unlessNotFound(observables.link(c.get("membership"), c.req.valid("param").number, type, value));
        if (!done) return c.json(notFound, 404);
        // 200 when it was already linked.
        return c.json({ observable: done.view }, done.linked ? 201 : 200);
      } catch (e) {
        if (e instanceof InvalidValue) return c.json({ error: e.message }, 400);
        return c.json(closedConflict(e), 409);
      }
    })
    .delete("/:number/observables/:id", zValidator("param", linkedParam), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const linked = await unlessNotFound(observables.unlink(c.get("membership"), number, id));
        if (!linked) return c.json(notFound, 404);
        return c.json({ observables: linked }, 200);
      } catch (e) {
        if (e instanceof NotLinked) return c.json({ error: e.message }, 404);
        return c.json(closedConflict(e), 409);
      }
    })
    .get("/:number/assets", zValidator("param", numberParam), async (c) => {
      const linked = await unlessNotFound(assets.list(c.get("membership"), c.req.valid("param").number));
      if (!linked) return c.json(notFound, 404);
      return c.json({ assets: linked }, 200);
    })
    .post("/:number/assets", zValidator("param", numberParam), zValidator("json", assetBody), async (c) => {
      const { type, value } = c.req.valid("json");
      try {
        const done = await unlessNotFound(assets.link(c.get("membership"), c.req.valid("param").number, type, value));
        if (!done) return c.json(notFound, 404);
        return c.json({ asset: done.view }, done.linked ? 201 : 200);
      } catch (e) {
        if (e instanceof InvalidValue) return c.json({ error: e.message }, 400);
        return c.json(closedConflict(e), 409);
      }
    })
    .delete("/:number/assets/:id", zValidator("param", linkedParam), async (c) => {
      const { number, id } = c.req.valid("param");
      try {
        const linked = await unlessNotFound(assets.unlink(c.get("membership"), number, id));
        if (!linked) return c.json(notFound, 404);
        return c.json({ assets: linked }, 200);
      } catch (e) {
        if (e instanceof NotLinked) return c.json({ error: e.message }, 404);
        return c.json(closedConflict(e), 409);
      }
    })
    .get("/:number/audit-log", zValidator("param", numberParam), zValidator("query", auditQuery), async (c) => {
      const { actor, action, from } = c.req.valid("query");
      const entries = await unlessNotFound(
        store.auditLog(c.get("membership"), c.req.valid("param").number, {
          actorId: actor,
          action,
          from: from ? new Date(from) : undefined,
        }),
      );
      if (!entries) return c.json(notFound, 404);
      return c.json({ entries }, 200);
    });
};
