import { afterEach, expect, test } from "bun:test";
import { S3Client } from "bun";
import { s3EvidenceStorage } from "./s3-storage";

/**
 * A minimal S3-compatible server (path-style HEAD, PUT and GET of single objects), so the adapter is
 * exercised through the S3 API itself.
 */
function fakeS3() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push(`${request.method} ${pathname}`);
      const object = objects.get(pathname);
      switch (request.method) {
        case "HEAD":
          return object ? new Response(null, { headers: { "content-length": String(object.bytes.length) } }) : new Response(null, { status: 404 });
        case "GET":
          return object ? new Response(object.bytes) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        case "PUT":
          objects.set(pathname, { bytes: new Uint8Array(await request.arrayBuffer()), contentType: request.headers.get("content-type") });
          return new Response(null, { headers: { etag: '"etag"' } });
        default:
          return new Response("Not supported by the fake", { status: 400 });
      }
    },
  });
  const client = new S3Client({
    bucket: "evidence",
    endpoint: server.url.origin,
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
  });
  return { storage: s3EvidenceStorage(client), objects, requests, stop: () => server.stop(true) };
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

const streamOf = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

test("stores a streamed file in the bucket under its key, with its content type, and reads it back", async () => {
  const s3 = fakeS3();
  stops.push(s3.stop);
  await s3.storage.put("org/case/1", streamOf("From: a@b.example\r\n", "\r\nPlease pay.\r\n"), "message/rfc822");
  const stored = s3.objects.get("/evidence/org/case/1");
  expect(new TextDecoder().decode(stored?.bytes)).toBe("From: a@b.example\r\n\r\nPlease pay.\r\n");
  expect(stored?.contentType).toBe("message/rfc822");
  expect(await new Response(await s3.storage.get("org/case/1")).text()).toBe("From: a@b.example\r\n\r\nPlease pay.\r\n");
});

test("refuses to write over an object that is already in the bucket", async () => {
  const s3 = fakeS3();
  stops.push(s3.stop);
  await s3.storage.put("org/case/1", streamOf("original"), "text/plain");
  await expect(s3.storage.put("org/case/1", streamOf("tampered"), "text/plain")).rejects.toThrow(/already exists/);
  expect(new TextDecoder().decode(s3.objects.get("/evidence/org/case/1")?.bytes)).toBe("original");
  expect(s3.requests.filter((r) => r.startsWith("PUT"))).toHaveLength(1);
});
