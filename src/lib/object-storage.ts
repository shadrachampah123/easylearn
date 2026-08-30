/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, …) with
 * presigned URLs.
 *
 * Teachers and learners upload files up to 100 MB directly from the browser to
 * the object store, so the bytes never pass through the app's serverless
 * function. That bypasses Vercel's ~4.5 MB request-body limit that breaks large
 * video uploads. The same signing machinery is used for downloads and deletes,
 * so bucket access can stay fully private (no public read needed).
 *
 * Server-only module (node:crypto). Never import from a client component.
 *
 * Required environment (all of these must be set to enable object storage):
 *   OBJECT_STORAGE_BUCKET             bucket name
 *   OBJECT_STORAGE_ACCESS_KEY_ID      access key id
 *   OBJECT_STORAGE_SECRET_ACCESS_KEY  secret access key
 *
 * Optional:
 *   OBJECT_STORAGE_ENDPOINT           base URL for non-AWS endpoints
 *                                     (R2: https://<account_id>.r2.cloudflarestorage.com)
 *   OBJECT_STORAGE_REGION             signing region ("auto" for R2, else us-east-1)
 *   OBJECT_STORAGE_FORCE_PATH_STYLE   "true" to use path-style URLs (default when
 *                                     an endpoint is set, e.g. R2/MinIO)
 *   OBJECT_STORAGE_PUBLIC_URL         public base URL for a public-read bucket;
 *                                     when set, downloads redirect straight to
 *                                     `${PUBLIC_URL}/${key}` instead of a signed URL
 *   OBJECT_STORAGE_UPLOAD_EXPIRY      seconds a presigned PUT stays valid (default 900)
 *   OBJECT_STORAGE_DOWNLOAD_EXPIRY    seconds a presigned GET stays valid (default 3600)
 */

import { createHash, createHmac, randomUUID } from "node:crypto";

export interface ObjectStorageConfig {
  enabled: boolean;
  bucket: string;
  /** Base URL (scheme + host, no trailing slash) for non-AWS endpoints. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Optional public read base URL (public buckets). */
  publicBaseUrl?: string;
  uploadExpirySeconds: number;
  downloadExpirySeconds: number;
}

function cleanEnv(value: string | undefined): string {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(cleanEnv(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getObjectStorageConfig(): ObjectStorageConfig {
  const bucket = cleanEnv(process.env.OBJECT_STORAGE_BUCKET);
  const accessKeyId = cleanEnv(process.env.OBJECT_STORAGE_ACCESS_KEY_ID);
  const secretAccessKey = cleanEnv(process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY);
  const endpoint = cleanEnv(process.env.OBJECT_STORAGE_ENDPOINT).replace(/\/+$/, "");
  const region =
    cleanEnv(process.env.OBJECT_STORAGE_REGION) || (endpoint ? "auto" : "us-east-1");
  const publicBaseUrl =
    cleanEnv(process.env.OBJECT_STORAGE_PUBLIC_URL).replace(/\/+$/, "") || undefined;

  const forcePathStyleEnv = cleanEnv(process.env.OBJECT_STORAGE_FORCE_PATH_STYLE).toLowerCase();
  const forcePathStyle = forcePathStyleEnv
    ? forcePathStyleEnv === "true" || forcePathStyleEnv === "1"
    : Boolean(endpoint); // R2 / MinIO only speak path-style

  return {
    enabled: Boolean(bucket && accessKeyId && secretAccessKey),
    bucket,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    publicBaseUrl,
    uploadExpirySeconds: positiveInt(process.env.OBJECT_STORAGE_UPLOAD_EXPIRY, 900),
    downloadExpirySeconds: positiveInt(process.env.OBJECT_STORAGE_DOWNLOAD_EXPIRY, 3600),
  };
}

export function isObjectStorageEnabled(): boolean {
  return getObjectStorageConfig().enabled;
}

/* ── RFC3986 encoding used throughout SigV4 ── */

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalUri(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

/* ── URL construction (path-style vs virtual-hosted-style) ── */

interface UrlParts {
  host: string;
  /** Full object URL (no query string). */
  url: string;
  /** Canonical URI used in the SigV4 canonical request (leading slash included). */
  path: string;
}

function objectUrlParts(config: ObjectStorageConfig, key: string): UrlParts {
  const encodedKey = canonicalUri(key);
  if (config.endpoint) {
    // Path-style (R2, MinIO): the bucket is the first path segment.
    const base = config.endpoint.replace(/\/+$/, "");
    const host = new URL(`${base}/`).host;
    const path = `/${encodeRfc3986(config.bucket)}/${encodedKey}`;
    return { host, path, url: `${base}${path}` };
  }

  // AWS virtual-hosted-style: the bucket lives in the host name.
  const host = `${config.bucket}.s3.${config.region}.amazonaws.com`;
  const path = `/${encodedKey}`;
  return { host, path, url: `https://${host}${path}` };
}

/** Public or signed URL used to read an object (the /api/files/<id> redirect target). */
export function objectDownloadUrl(config: ObjectStorageConfig, key: string): string {
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/${canonicalUri(key)}`;
  }
  return presignUrl(config, {
    method: "GET",
    key,
    expiresSeconds: config.downloadExpirySeconds,
  }).url;
}

/* ── AWS Signature Version 4 presigner (no SDK dependency) ── */

interface PresignRequest {
  method: "GET" | "PUT" | "DELETE";
  key: string;
  expiresSeconds: number;
  /** Optional extra header to sign (PUT content type). */
  contentType?: string;
  now?: Date;
}

interface PresignedUrl {
  url: string;
  /** Headers the client must send verbatim with the request. */
  headers: Record<string, string>;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hex(data: Buffer): string {
  return data.toString("hex");
}

export function presignUrl(config: ObjectStorageConfig, request: PresignRequest): PresignedUrl {
  const now = request.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const { host, url, path } = objectUrlParts(config, request.key);

  // Headers to sign. Presigned URLs sign `host` (always) and any extra headers
  // that the caller promises to echo (e.g. Content-Type on a PUT).
  const signedHeaders: string[] = [];
  const canonicalHeaderLines: string[] = [];
  if (request.contentType) {
    signedHeaders.push("content-type");
    canonicalHeaderLines.push(`content-type:${request.contentType}`);
  }
  signedHeaders.push("host");
  canonicalHeaderLines.push(`host:${host}`);
  const signedHeadersString = signedHeaders.join(";");
  const canonicalHeaders = canonicalHeaderLines.join("\n") + "\n";

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(request.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeadersString,
  };

  const canonicalQueryString = Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key])}`)
    .join("&");

  const canonicalRequest = [
    request.method,
    path,
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersString,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hex(createHash("sha256").update(canonicalRequest).digest()),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
    "aws4_request"
  );

  const signature = hex(hmac(signingKey, stringToSign));

  const finalUrl = `${url}?${canonicalQueryString}&X-Amz-Signature=${signature}`;

  return {
    url: finalUrl,
    headers: request.contentType ? { "Content-Type": request.contentType } : {},
  };
}

/* ── High-level helpers used by the API routes ── */

/** Object key for a new upload: purpose-scoped folder + unique file name. */
export function newObjectKey(purpose: "assignment" | "submission", extension: string): string {
  const id = randomUUID();
  return `uploads/${purpose}/${id}${extension ? `.${extension}` : ""}`;
}

export function presignedUploadUrl(
  config: ObjectStorageConfig,
  key: string,
  contentType: string
): PresignedUrl {
  return presignUrl(config, {
    method: "PUT",
    key,
    expiresSeconds: config.uploadExpirySeconds,
    contentType,
  });
}

/** Best-effort server-side delete via a presigned DELETE request. */
export async function deleteObject(
  config: ObjectStorageConfig,
  key: string
): Promise<boolean> {
  if (!config.enabled) return false;
  const { url } = presignUrl(config, {
    method: "DELETE",
    key,
    expiresSeconds: config.uploadExpirySeconds,
  });
  try {
    const response = await fetch(url, { method: "DELETE" });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
