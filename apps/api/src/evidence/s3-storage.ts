import type { S3Client } from "bun";
import { type EvidenceStorage, EvidenceObjectExists } from "./storage";

/*
 * Kept apart from `storage.ts`: the SPA type-checks the API's routes, and importing "bun" there would
 * bring Bun's globals into its program. Only `config.ts` builds this.
 */

/** Uploads in 16 MiB parts, four at a time: big enough for multi-gigabyte files to stay under S3's 10,000 parts. */
const PART_SIZE = 16 * 1024 * 1024;

/** Evidence in an S3-compatible bucket, through Bun's S3 client. */
export function s3EvidenceStorage(client: S3Client): EvidenceStorage {
  return {
    async put(key, body, contentType) {
      const file = client.file(key);
      if (await file.exists()) throw new EvidenceObjectExists(key);
      const writer = file.writer({ type: contentType, partSize: PART_SIZE, queueSize: 4, retry: 3 });
      try {
        for await (const chunk of body) await writer.write(chunk);
      } catch (e) {
        // Abandons the upload rather than completing it with what arrived so far.
        await writer.end(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
      await writer.end();
    },
    async get(key) {
      return client.file(key).stream();
    },
  };
}

