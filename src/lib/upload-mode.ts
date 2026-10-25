/**
 * Server-side upload messages and safe failure diagnostics.
 *
 * These are pure helpers, kept out of the route handler so they can be unit-tested
 * without a browser, a database or a live bucket.
 *
 * Why this module exists
 * ──────────────────────
 * Two production-only defects motivated it:
 *
 *  1. `Bearer null`. A browser that interpolated a missing credential produced the
 *     literal header value `Authorization: Bearer null`. The token parser accepted any
 *     non-empty bearer value, so it returned the STRING "null" and never consulted the
 *     session cookie — turning a valid cookie session into a 401. The parser itself is
 *     fixed in `src/lib/auth.ts`; this module no longer carries a client header helper,
 *     because the browser now authenticates with the `httpOnly` cookie via `apiFetch`
 *     (see `src/lib/api-client.ts`) and sends no `Authorization` header at all.
 *
 *  2. Opaque 500 where the disk path cannot work. A serverless deployment mounts its
 *     bundle READ-ONLY, so a write under it fails with EROFS and the user saw only
 *     "The file could not be uploaded. Please try again." — a generic 500 that named
 *     no cause. `POST /api/uploads` now probes writability and answers 409 with
 *     `MULTIPART_DISABLED_MESSAGE` instead of attempting an impossible write.
 *
 *     Note what this is NOT. Object storage being configured does not, on its own,
 *     make the local path invalid: a deployment may have a bucket AND a writable
 *     filesystem, and there the multipart route is still the supported path for small
 *     files. The guard therefore keys on the FILESYSTEM, not the configuration — it
 *     refuses only the read-only case. Keying on configuration would break the
 *     documented "the local path is unaffected" guarantee (see
 *     tests/object-storage-live.test.ts and tests/upload-multipart-disk-fallback.test.ts).
 *
 * Only the pieces the route actually uses live here; `describeUploadFailure` exists so
 * the failure is diagnosable without logging anything sensitive.
 */

/** Message returned by the multipart endpoint when object storage is configured. */
export const MULTIPART_DISABLED_MESSAGE =
  "This deployment stores files in cloud object storage, so local-disk uploads are unavailable. " +
  "Retry the upload: the browser should use the direct cloud upload path.";

/**
 * Safe, structured description of an upload failure for server logs.
 *
 * Deliberately excludes credentials, signed URLs, object keys, file names and file
 * contents. Only the error class, a conservative error code and coarse metadata are
 * emitted, which is enough to tell a read-only-filesystem failure (`EROFS`) from a
 * schema gap or a database outage without leaking anything.
 */
export function describeUploadFailure(
  error: unknown,
  meta: { backend: "local" | "object"; fileCount: number }
): string {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const name = typeof candidate?.name === "string" ? candidate.name : "Error";
  const code = typeof candidate?.code === "string" ? candidate.code : "UNKNOWN";
  /* `message` is intentionally NOT logged: driver messages can embed connection
     strings or parameter values. */
  return `upload failed: backend=${meta.backend} files=${meta.fileCount} error=${name} code=${code}`;
}
