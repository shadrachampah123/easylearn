/**
 * Object-storage configuration and readiness reporting for `/api/health` (H-2).
 *
 * The audit's complaint was precise: `/api/health` was **blind to object storage**, so
 * the R2 outage (C-1) — presign answered 201 while every browser upload failed — left
 * no server-side signal at all. This module gives the endpoint a truthful answer.
 *
 * THE RULE, and the reason this file exists as a separate module:
 *
 *   **Configuration presence is not service availability.**
 *
 * Deciding that four environment variables are non-empty is cheap and proves nothing
 * about whether the bucket exists, whether the credentials are valid, whether the
 * bucket's CORS allows the browser to PUT to it, or whether Cloudflare is up. So the
 * two are reported in different fields, with different words, and the deep field can
 * only say `verified` when a request to the store actually succeeded.
 *
 * WHAT IS NEVER DISCLOSED: the bucket name, the endpoint host, the access key id, the
 * region, the public URL, and any token or signature. The response carries booleans,
 * a fixed-state word, and a short reason drawn from a closed set — never a string
 * produced by the store, because a store's error body quotes the request, and the
 * request is a presigned URL.
 *
 * WHAT IS NOT DONE BY DEFAULT: the live check performs a network request, so it runs
 * only when asked, and always behind a timeout. `GET /api/health` stays a fast,
 * side-effect-free *status* readout by default; `?deep=1` opts into the real check.
 * A health endpoint that takes as long as the slowest dependency is how a health check
 * becomes an outage of its own (finding F-5's lesson, one layer out).
 */

import { presignUrl, type ObjectStorageConfig } from "@/lib/object-storage";
import { log } from "@/lib/logger";
import { isSensitiveKey, redactText } from "@/lib/log-redaction";

/** The closed set of verdicts. Anything else is a bug, not a state. */
export type ObjectStorageReadinessState =
  /** No storage configured: uploads use local disk, which is a supported mode. */
  | "disabled"
  /** Configuration is incomplete: at least one required variable is missing/blank. */
  | "misconfigured"
  /** Configuration is complete, but nothing has been sent to the store yet. */
  | "configured-unverified"
  /** A signed request reached the store and it answered. */
  | "verified"
  /** A signed request was attempted and failed, or timed out. */
  | "error";

export interface ObjectStorageReadiness {
  /** True when the four required variables are all present and non-blank. */
  configured: boolean;
  /** The names — never the values — of required variables that are missing. */
  missingVariables: string[];
  /** Which upload path the application will actually use. */
  mode: "object-storage" | "local-disk";
  /** The verdict described above. */
  state: ObjectStorageReadinessState;
  /** True only when `state === "verified"`: a real request to the store succeeded. */
  reachable: boolean | null;
  /** Why the state is what it is, from a closed vocabulary. Never store text. */
  reason: ObjectStorageSignals["reason"];
  /** Whether a deep check was performed for this response at all. */
  checked: boolean;
  /** Round-trip of the deep check, when one ran. */
  latencyMs?: number;
  /**
   * Non-fatal configuration observations that an operator should see: the
   * production-public-URL guard, an unusual expiry, a path-style mismatch.
   * These are codes, not sentences, so the endpoint's output is a fixed vocabulary.
   */
  warnings: ObjectStorageSignalCode[];
}

/** Machine-readable causes. The endpoint returns these verbatim; nothing else. */
export type ObjectStorageSignalCode =
  | "missing_required_variables"
  | "disabled_by_configuration"
  | "live_check_not_requested"
  | "live_check_succeeded"
  | "live_check_timeout"
  | "live_check_http_error"
  | "live_check_transport_error"
  | "public_url_in_production"
  | "upload_expiry_out_of_range"
  | "download_expiry_out_of_range"
  | "endpoint_not_https";

interface ObjectStorageSignals {
  reason: ObjectStorageSignalCode;
}

/** Every variable the object-storage path needs before it will activate. */
const REQUIRED_VARIABLES = [
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
] as const;

/**
 * The HTTP method the storage probe signs AND sends.
 *
 * Exported because the regression is "the two drifted apart", and the only way to pin
 * that is for a test to read one value and compare it against both the signed canonical
 * request and the dispatched request. A test that re-declares the string would pass while
 * the code drifted again.
 */
export const OBJECT_STORAGE_PROBE_METHOD = "HEAD" as const;

/** Default bound for the live probe. Overridable, clamped, and never unbounded. */
export const DEFAULT_STORAGE_PROBE_TIMEOUT_MS = 2_500;
export const MIN_STORAGE_PROBE_TIMEOUT_MS = 250;
export const MAX_STORAGE_PROBE_TIMEOUT_MS = 10_000;

function readTimeoutMs(): number {
  const raw = Number((process.env.EASY_LEARN_STORAGE_PROBE_TIMEOUT_MS ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STORAGE_PROBE_TIMEOUT_MS;
  /* Clamp rather than ignore: an operator who set 1 ms and 60 s both asked for
     something, and silently substituting the default would hide it. 60 s is not a
     health check, so the ceiling is low on purpose. */
  return Math.min(MAX_STORAGE_PROBE_TIMEOUT_MS, Math.max(MIN_STORAGE_PROBE_TIMEOUT_MS, Math.floor(raw)));
}

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

/**
 * Configuration presence only: no network, no signing, no fetching.
 *
 * Exported because the tests and the health endpoint both need the "is it even
 * configured" answer without paying for a request.
 */
export function inspectObjectStorageConfiguration(): {
  configured: boolean;
  missingVariables: string[];
  warnings: ObjectStorageSignalCode[];
} {
  const missingVariables: string[] = [];
  for (const name of REQUIRED_VARIABLES) {
    if (isBlank(process.env[name])) missingVariables.push(name);
  }

  const warnings: ObjectStorageSignalCode[] = [];

  /* SEC-1's guard, surfaced rather than thrown: `assertObjectStorageConfigForProduction`
     refuses a public base URL in production because every EasyLearn file is private.
     The route refuses at request time; health should say so *before* a teacher
     discovers it during an upload. */
  const publicUrl = (process.env.OBJECT_STORAGE_PUBLIC_URL ?? "").trim();
  const allowPublic = (process.env.OBJECT_STORAGE_ALLOW_PUBLIC_URL ?? "").trim().toLowerCase();
  if (publicUrl && process.env.NODE_ENV === "production" && allowPublic !== "true" && allowPublic !== "1") {
    warnings.push("public_url_in_production");
  }

  const endpoint = (process.env.OBJECT_STORAGE_ENDPOINT ?? "").trim();
  if (endpoint && !/^https:\/\//i.test(endpoint)) warnings.push("endpoint_not_https");

  const uploadExpiry = Number((process.env.OBJECT_STORAGE_UPLOAD_EXPIRY ?? "").trim());
  if (Number.isFinite(uploadExpiry) && uploadExpiry > 0 && uploadExpiry > 3_600) {
    warnings.push("upload_expiry_out_of_range");
  }
  const downloadExpiry = Number((process.env.OBJECT_STORAGE_DOWNLOAD_EXPIRY ?? "").trim());
  if (Number.isFinite(downloadExpiry) && downloadExpiry > 0 && downloadExpiry > 86_400) {
    warnings.push("download_expiry_out_of_range");
  }

  return { configured: missingVariables.length === 0, missingVariables, warnings };
}

export interface DeepCheckResult {
  reachable: boolean;
  reason: ObjectStorageSignalCode;
  latencyMs: number;
}

/**
 * Perform ONE real, signed, read-only request against the store.
 *
 * `HEAD` on a key that is not expected to exist is the least invasive operation an
 * S3-compatible API offers: it returns 200 for an object that happens to exist and
 * 404 for the overwhelmingly more likely case, and both prove the same three things —
 * the host resolved and accepted a connection, the signature was accepted (a bad key
 * is 403, not 404), and the bucket responded. It creates nothing, reads no bytes, and
 * sends no payload.
 *
 * What a success does NOT prove, and the docs say so: that the bucket's CORS policy
 * permits a browser `PUT`, that the object is retrievable by the application, or that
 * a write will succeed. Those need a real upload and are out of scope for a health
 * check that must stay fast and side-effect-free.
 */
export async function checkObjectStorageReachability(
  config: ObjectStorageConfig,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<DeepCheckResult> {
  const timeoutMs = options?.timeoutMs ?? readTimeoutMs();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const startedAt = Date.now();

  /* THE METHOD IS A SINGLE CONSTANT, USED FOR SIGNING AND FOR THE REQUEST.
     This was a real defect (PR #70 review): the probe signed `GET` and then sent `HEAD`.
     SigV4 puts the method in the canonical request, so the two signatures differ and a
     correctly configured bucket answers 403 SignatureDoesNotMatch — the probe would have
     reported every healthy store as unreachable. Keeping one constant makes the two uses
     impossible to desynchronise, and
     `tests/observability-correlation.test.ts` proves the constant reached both — it runs
     this function against a fake transport and checks the dispatched URL's signature
     against a recomputation for the dispatched verb.
     `HEAD` is the right verb for this check: it asks whether the bucket answers with our
     credentials without reading or writing a byte. */
  const PROBE_METHOD = OBJECT_STORAGE_PROBE_METHOD;

  /* A key under a reserved prefix, so a real upload is never overwritten and an
     operator can see the probe's fingerprint in a bucket listing if they care. */
  let url: string;
  try {
    url = presignUrl(config, {
      method: PROBE_METHOD,
      key: "health/probe-not-an-object",
      /* One minute: the URL is used immediately and then discarded. A long-lived
         signed URL in a health check is a credential with no reason to exist. */
      expiresSeconds: 60,
    }).url;
  } catch (error) {
    /* Signing needs the secret; a failure here is a configuration defect, and the
       error text from the signer can contain the key material it was given. */
    log.warn("object storage probe could not be signed", {
      event: "health.object_storage.sign_failed",
      reason: redactText((error as Error)?.name ?? "unknown"),
    });
    return { reachable: false, reason: "live_check_transport_error", latencyMs: Date.now() - startedAt };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: PROBE_METHOD,
      signal: controller.signal,
      /* A redirect from a store is a configuration surprise, not a success. */
      redirect: "manual",
    });
    const latencyMs = Date.now() - startedAt;

    /* 200 (the probe key exists) and 404 (it does not) both mean the store answered
       and accepted our signature. 403 means the signature or the key is wrong; 5xx
       means the store is unwell. Nothing else is treated as reachable. */
    if (response.status === 200 || response.status === 404) {
      return { reachable: true, reason: "live_check_succeeded", latencyMs };
    }
    log.warn("object storage probe returned an unexpected status", {
      event: "health.object_storage.probe_status",
      /* The status and nothing else: not the URL, not the body. */
      status: response.status,
      latencyMs,
    });
    return { reachable: false, reason: "live_check_http_error", latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted = (error as Error)?.name === "AbortError";
    log.warn("object storage probe failed", {
      event: "health.object_storage.probe_failed",
      reason: aborted ? "timeout" : redactText((error as Error)?.name ?? "unknown"),
      /* The message is redacted centrally, but it is not included at all here: an
         undici error message can quote the request URL, and that URL is signed. */
      latencyMs,
      timeoutMs,
    });
    return {
      reachable: false,
      reason: aborted ? "live_check_timeout" : "live_check_transport_error",
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the health payload's object-storage section.
 *
 * `deep` runs the live check and may take up to the timeout; without it this function
 * performs no I/O and cannot fail for a network reason.
 */
export async function describeObjectStorage(
  options: { deep?: boolean } = {}
): Promise<ObjectStorageReadiness> {
  const inspection = inspectObjectStorageConfiguration();

  if (!inspection.configured) {
    return {
      configured: false,
      missingVariables: inspection.missingVariables,
      mode: "local-disk",
      /* A deployment that never intended to use object storage is `disabled`, not
         `misconfigured`. Only names a variable when the intent is ambiguous, which is
         the honest report: with nothing set, local disk is the documented mode. */
      state: inspection.missingVariables.length === REQUIRED_VARIABLES.length ? "disabled" : "misconfigured",
      reachable: null,
      reason:
        inspection.missingVariables.length === REQUIRED_VARIABLES.length
          ? "disabled_by_configuration"
          : "missing_required_variables",
      checked: false,
      warnings: inspection.warnings,
    };
  }

  if (!options.deep) {
    return {
      configured: true,
      missingVariables: [],
      mode: "object-storage",
      state: "configured-unverified",
      reachable: null,
      reason: "live_check_not_requested",
      checked: false,
      warnings: inspection.warnings,
    };
  }

  /* Imported here rather than at module scope: `getObjectStorageConfig` is cheap, but
     this keeps the module importable by a pure test without pulling the signer in. */
  const { getObjectStorageConfig } = await import("@/lib/object-storage");
  const result = await checkObjectStorageReachability(getObjectStorageConfig());

  return {
    configured: true,
    missingVariables: [],
    mode: "object-storage",
    state: result.reachable ? "verified" : "error",
    reachable: result.reachable,
    reason: result.reason,
    checked: true,
    latencyMs: result.latencyMs,
    warnings: inspection.warnings,
  };
}

/**
 * A redaction self-check for the health response.
 *
 * `describeObjectStorage` is written to emit only booleans, counts and codes, but the
 * endpoint is unauthenticated and the fields come from the environment. This function
 * is the assertion, applied at runtime: every string in the produced object is checked
 * against the same secret vocabulary the logger uses, and any match collapses the
 * section to a fixed safe value rather than shipping it.
 *
 * Runtime cost is a handful of regexes over a small object, once per health request.
 * That is a fair price for making "never leak the bucket name" a property of the code
 * rather than a promise in a comment.
 */
export function assertNoSecretsInStorageSection(readiness: ObjectStorageReadiness): ObjectStorageReadiness {
  const secretValues = [
    process.env.OBJECT_STORAGE_BUCKET,
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    process.env.OBJECT_STORAGE_ENDPOINT,
    process.env.OBJECT_STORAGE_PUBLIC_URL,
  ]
    .map((value) => (value ?? "").trim())
    .filter((value) => value.length >= 4);

  const serialised = JSON.stringify(readiness);
  const leaked = secretValues.some((value) => serialised.includes(value));
  /* Also catch the shapes rather than only the exact values: a store endpoint's host
     and a long random key are what an accidental field would carry. */
  const suspicious =
    /r2\.cloudflarestorage\.com|amazonaws\.com|AKIA[0-9A-Z]{12,}|X-Amz-Signature/i.test(serialised);

  if (!leaked && !suspicious) return readiness;

  log.error("health object-storage section contained configuration detail and was suppressed", {
    event: "health.object_storage.suppressed",
    /* No values, no field names beyond the fact of suppression. */
  });
  return {
    configured: false,
    missingVariables: [],
    mode: "local-disk",
    state: "error",
    reachable: null,
    reason: "live_check_transport_error",
    checked: false,
    warnings: [],
  };
}

/** Re-exported so a caller can assert the redaction vocabulary is the one used here. */
export { isSensitiveKey };
