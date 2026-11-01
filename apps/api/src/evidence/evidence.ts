import { and, asc, eq } from "drizzle-orm";
import { visibleCases } from "../access/policy";
import { actorOf, CaseClosed, CaseNotFound, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { cases, evidence, user } from "../db/schema";
import type { EvidenceConfig } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";

/**
 * A Case's Evidence. Anyone who can see the Case adds files while it isn't Closed; each is
 * fingerprinted with SHA-256 as its bytes arrive, and is never replaced or deleted (ADR 0003).
 *
 * Its bytes go only through here, to people the access policy lets see the Case, and every view
 * and download is recorded in the Case Audit Log before the bytes are handed over. There are no
 * public or pre-signed URLs.
 */

export class EvidenceNotFound extends Error {
  constructor() {
    super("Evidence not found");
  }
}
/** The file is larger than the Organization's deployment accepts. */
export class EvidenceTooLarge extends Error {
  constructor(maxBytes: number) {
    super(`Evidence can be at most ${maxBytes} bytes`);
  }
}
/** An empty file has nothing to fingerprint. */
export class EvidenceEmpty extends Error {
  constructor() {
    super("The file is empty");
  }
}
export { CaseClosed, CaseNotFound };

export type NewEvidence = { name: string; contentType: string; body: ReadableStream<Uint8Array> };

export type EvidenceView = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** SHA-256 of the file as added, lowercase hex. */
  sha256: string;
  addedBy: { id: string; name: string };
  addedAt: string;
};

/** How someone opened Evidence; each is its own Case Audit Log action. */
export type EvidenceAccess = "view" | "download";
const accessAction = { view: "evidence.viewed", download: "evidence.downloaded" } as const;

/**
 * Bun's incremental hasher. Declared rather than taken from Bun's types: the SPA type-checks the
 * API's routes, and Bun's globals would clash with the browser's there.
 */
declare const Bun: {
  CryptoHasher: new (algorithm: "sha256") => { update(data: Uint8Array): unknown; digest(encoding: "hex"): string };
};

/** Passes `body` through, counting and fingerprinting it, and fails it once it passes `maxBytes`. */
function fingerprinted(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new EvidenceTooLarge(maxBytes);
        hasher.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, result: () => ({ size, sha256: hasher.digest("hex") }) };
}

export function evidenceStore({ db, clock, evidence: config }: { db: Db; clock: Clock; evidence: EvidenceConfig }) {
  const columns = {
    id: evidence.id,
    name: evidence.name,
    contentType: evidence.contentType,
    size: evidence.sizeBytes,
    sha256: evidence.sha256,
    storageKey: evidence.storageKey,
    addedById: evidence.addedById,
    addedByName: user.name,
    addedAt: evidence.addedAt,
  };
  /** The Case's Evidence (or just `id`) as `me` sees it, oldest first; throws `CaseNotFound` when they can't see the Case. */
  const select = async (me: Membership, number: number, id?: string) => {
    const [found] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    if (!found) throw new CaseNotFound();
    return db
      .select(columns)
      .from(evidence)
      .innerJoin(user, eq(evidence.addedById, user.id))
      .where(and(eq(evidence.caseId, found.id), id ? eq(evidence.id, id) : undefined))
      .orderBy(asc(evidence.seq));
  };

  const toView = (r: Awaited<ReturnType<typeof select>>[number]): EvidenceView => ({
    id: r.id,
    name: r.name,
    contentType: r.contentType,
    size: r.size,
    sha256: r.sha256,
    addedBy: { id: r.addedById, name: r.addedByName },
    addedAt: r.addedAt.toISOString(),
  });

  return {
    /** The Case's Evidence, oldest first; throws `CaseNotFound` when `me` can't see the Case. */
    list: async (me: Membership, number: number) => (await select(me, number)).map(toView),

    /**
     * Adds a file as Evidence, streaming it to storage while fingerprinting it. The Case is checked
     * before the upload starts, so a refusal comes before the bytes are sent, and again as the
     * Evidence is recorded.
     */
    async add(me: Membership, number: number, file: NewEvidence) {
      const [target] = await db
        .select({ id: cases.id, status: cases.status })
        .from(cases)
        .where(and(visibleCases(me), eq(cases.number, number)))
        .limit(1);
      if (!target) throw new CaseNotFound();
      if (target.status === "closed") throw new CaseClosed();

      const id = secureId();
      // Fresh for every file, so nothing already stored is ever written over.
      const storageKey = `${me.organizationId}/${target.id}/${id}`;
      const counted = fingerprinted(file.body, config.maxBytes);
      await config.storage.put(storageKey, counted.stream, file.contentType);
      const { size, sha256 } = counted.result();
      // What was stored stays in the bucket unreferenced; nothing is ever deleted from it.
      if (size === 0) throw new EvidenceEmpty();

      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        await tx.insert(evidence).values({
          id,
          organizationId: me.organizationId,
          caseId: current.id,
          name: file.name,
          contentType: file.contentType,
          sizeBytes: size,
          sha256,
          storageKey,
          addedById: me.userId,
          addedAt: now,
        });
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "evidence.added",
          target: file.name,
          after: `SHA-256 ${sha256}`,
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
      });
      const [added] = await select(me, number, id);
      if (!added) throw new EvidenceNotFound();
      return toView(added);
    },

    /**
     * Opens Evidence to view or download: records the access in the Case Audit Log, then returns
     * the file with its bytes. Allowed on a Closed Case, which stays readable.
     */
    async open(me: Membership, number: number, id: string, access: EvidenceAccess) {
      const now = clock.now();
      const row = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number, "allow");
        const [found] = await tx
          .select(columns)
          .from(evidence)
          .innerJoin(user, eq(evidence.addedById, user.id))
          .where(and(eq(evidence.id, id), eq(evidence.caseId, current.id)));
        if (!found) throw new EvidenceNotFound();
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: accessAction[access],
          target: found.name,
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
        return found;
      });
      return { evidence: toView(row), body: await config.storage.get(row.storageKey) };
    },
  };
}

export type EvidenceStore = ReturnType<typeof evidenceStore>;
