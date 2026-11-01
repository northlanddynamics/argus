/**
 * Where Evidence files live: an S3-compatible bucket (ADR 0001, `s3-storage.ts`), so the storage provider is chosen
 * at deploy time. Objects are written once under a fresh key and never overwritten or deleted, so
 * there is deliberately no way to do either here. For a bucket nobody can alter even from outside
 * Argus, turn on S3 Object Lock.
 *
 * Bytes are streamed both ways: Evidence can be a multi-gigabyte memory image.
 */
export interface EvidenceStorage {
  /** Stores `body` under `key`. Refuses a key that already holds an object. */
  put(key: string, body: ReadableStream<Uint8Array>, contentType: string): Promise<void>;
  /** The object's bytes. */
  get(key: string): Promise<ReadableStream<Uint8Array>>;
}

/** A key already holds an object, and objects are never overwritten. */
export class EvidenceObjectExists extends Error {
  constructor(key: string) {
    super(`Evidence object ${key} already exists`);
  }
}

/** Evidence in memory, for tests. `objects` shows what was stored. */
export function memoryEvidenceStorage() {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>();
  const storage: EvidenceStorage = {
    async put(key, body, contentType) {
      if (objects.has(key)) throw new EvidenceObjectExists(key);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, contentType });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) throw new Error(`No Evidence object ${key}`);
      return new Response(object.bytes).body!;
    },
  };
  return { storage, objects };
}

/** Stands in when no bucket is configured: everything else works, and Evidence fails with a clear reason. */
export const unconfiguredEvidenceStorage: EvidenceStorage = {
  async put() {
    throw new Error("Evidence storage is not configured: set S3_BUCKET and its credentials");
  },
  async get() {
    throw new Error("Evidence storage is not configured: set S3_BUCKET and its credentials");
  },
};
