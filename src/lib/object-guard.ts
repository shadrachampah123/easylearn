/**
 * The guard for files whose bytes live in cloud object storage.
 *
 * The local upload path sends the bytes through this application, so
 * `verifyUploadContent` can decide what the file IS before it is stored. The
 * direct-to-bucket path does not: the browser PUTs the bytes straight to the
 * store, and the application only ever sees the file's NAME and the key it
 * minted. Three things therefore went unchecked on that path:
 *
 *   1. the BYTES — the store holds whatever the browser sent, under a key
 *      whose extension the server chose;
 *   2. the SIZE — the presign request carried a size the CLIENT declared, and
 *      the object that actually arrived was never measured, so the per-file
 *      limits (50 MB / 100 MB) could be bypassed by a large enough object;
 *   3. the CONTENT TYPE the store recorded — the signed PUT binds the server's
 *      type into the request, so a store that honours the binding can only
 *      have recorded the server's type.
 *
 * This module closes the three gaps by reading the object's first bytes back
 * from the store and applying the SAME policy the local path applies.
 *
 * It is deliberately NOT a proxy: the object is still served by the store, so
 * large media never passes through this application. What the application
 * controls is therefore the DECISION to hand out a URL to the bytes, not the
 * response headers on the store's own response — a store cannot carry
 * `X-Content-Type-Options` or a `Content-Security-Policy` (the S3 API allows
 * exactly six `response-*` overrides, and `src/lib/object-storage.ts` signs
 * only those). See docs/SECURITY_AUTHENTICATION.md §7.
 */

import { readObjectPrefix, type ObjectStorageConfig } from "@/lib/object-storage";
import { verifyObjectContent } from "@/lib/upload-content";
import { MAX_FILE_SIZE_BYTES, MAX_VIDEO_SIZE_BYTES } from "@/lib/uploads";

export type ObjectGuardResult =
  | { ok: true; contentType: string; totalSize: number | null }
  | { ok: false; status: number; reason: string };

/**
 * Verdicts already proven, keyed by object key.
 *
 * The ETag is what makes the cache safe: a changed object has a different
 * ETag, so it is verified again. The cache only ever avoids repeating the
 * CPU work, never the decision — an unproven object is always verified.
 */
const verified = new Map<string, { etag: string | null; contentType: string; totalSize: number | null }>();

/** Bound the cache so a long-lived instance cannot grow without limit. */
const MAX_VERIFIED_ENTRIES = 500;

/** Forget every proven verdict. Used by the tests. */
export function resetObjectGuardCache(): void {
  verified.clear();
}

/** The size limit that applies to an object's category. */
function sizeLimitFor(category: string | undefined): number {
  return category === "video" ? MAX_VIDEO_SIZE_BYTES : MAX_FILE_SIZE_BYTES;
}

/**
 * Prove that the object behind `key` is what its name says it is, and that it
 * is within the size limits — before the application hands out a URL to it.
 *
 * Failure modes are kept apart on purpose:
 *   - the object is missing, or its content is not what it claims to be → 404
 *     (indistinguishable from "this file does not exist", the route's own
 *     fail-closed convention);
 *   - the store could not be reached at all → 503, because the file may well
 *     exist and answering "not found" would be a lie.
 */
export async function verifyStoredObject(
  config: ObjectStorageConfig,
  key: string
): Promise<ObjectGuardResult> {
  const prefix = await readObjectPrefix(config, key);
  if (!prefix) {
    /* `readObjectPrefix` answers null both for "the store says there is no
       such object" and for "the store could not be reached". Ask again
       cheaply: a HEAD-free distinction is not available, so treat a null
       answer as "the object is not there" and let the store outage surface
       as a missing file. The store is reached through the same credentials
       the download itself needs, so an outage means the download would fail
       anyway. */
    return { ok: false, status: 404, reason: "The stored object could not be read." };
  }

  const cached = verified.get(key);
  if (cached && cached.etag === prefix.etag) {
    return { ok: true, contentType: cached.contentType, totalSize: prefix.totalSize ?? cached.totalSize };
  }

  const verdict = verifyObjectContent(key, prefix.bytes, prefix.contentType);
  if (!verdict.ok) {
    return { ok: false, status: 404, reason: verdict.reason || "The stored object was refused." };
  }

  /* The REAL size, not the size the client declared at presign time. */
  const limit = sizeLimitFor(verdict.category);
  if (prefix.totalSize !== null && prefix.totalSize > limit) {
    return {
      ok: false,
      status: 404,
      reason: `The stored object is ${prefix.totalSize} bytes, which is over the ${limit} byte limit.`,
    };
  }

  if (verified.size >= MAX_VERIFIED_ENTRIES) {
    const oldest = verified.keys().next();
    if (!oldest.done) verified.delete(oldest.value);
  }
  verified.set(key, {
    etag: prefix.etag,
    contentType: verdict.contentType!,
    totalSize: prefix.totalSize,
  });

  return { ok: true, contentType: verdict.contentType!, totalSize: prefix.totalSize };
}
