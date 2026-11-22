/**
 * Structured server-side logging with request correlation (H-2).
 *
 * WHAT THIS IS: one line of JSON per event, written to stdout/stderr, which is what
 * Vercel collects from a serverless function. It is deliberately **not** a monitoring
 * service: no dependency, no network call, no vendor. The runtime log *is* the
 * transport; alerting is configured on the platform side against these lines (see
 * docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md § H-2 for the exact rules).
 *
 * CORRELATION: every request gets an id. If the edge supplied one it is reused, but
 * only after validation — a client-supplied header must not be able to write arbitrary
 * text into the log or claim another request's id. Otherwise a random id is generated.
 * The id is echoed on `/api/health` failure responses and included in every line
 * logged while that request is being served, so an operator can go from a user's
 * screenshot to the exact log line.
 *
 * REDACTION: every field, message and error goes through `redactValue` before it is
 * serialised. A secret cannot reach the output by being put in the wrong field.
 *
 * FAILURE MODE — the requirement in the H-2 brief, and the reason for the defensive
 * shape of this file: **a logging failure must not crash a request.** `console.error`
 * can throw (a closed stdout, an EPIPE, a full disk, a platform shim), `JSON.stringify`
 * can throw on a BigInt or a cyclic graph, and a redactor can throw on pathological
 * input. Each of those is caught here, downgraded to a fixed plain-text line, and the
 * request continues. `emit` therefore has type `void`, and callers cannot accidentally
 * build control flow on it.
 */

import { randomUUID } from "node:crypto";
import { redactText, redactValue } from "@/lib/log-redaction";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  /** Stable, low-cardinality event name, e.g. `request.error`, `schema.repair_failed`. */
  event?: string;
  /** Request id, so a line joins the rest of its request. */
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  /** Anything else. Redacted structurally, so a secret here is still dropped. */
  [key: string]: unknown;
}

/**
 * Events that are expected and noisy, plus the two that are security-signal.
 *
 * The set is small on purpose: a level system with six adjectives invites arguments
 * about names. `debug` is suppressed unless `EASY_LEARN_LOG_LEVEL=debug`.
 */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const raw = (process.env.EASY_LEARN_LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  /* Production defaults to `info`: debug lines are useful locally and expensive on a
     metered log platform, and every line here carries the same fields an alert would
     use, so nothing is lost for alerting. `EASY_LEARN_LOG_DEBUG` is the older,
     narrower switch kept for the existing developer workflow. */
  if (process.env.EASY_LEARN_LOG_DEBUG === "true") return "debug";
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  try {
    return LEVEL_RANK[level] >= LEVEL_RANK[configuredLevel()];
  } catch {
    return true;
  }
}

/**
 * A request id that is safe to write to a log and safe to echo to a client.
 *
 * Vercel sets `x-vercel-id` (and `x-vercel-request-id` on some plans). Either is used
 * when it matches the character class below; anything else is replaced with a fresh
 * UUID. The class excludes whitespace, quotes, control characters and the log
 * separators, so an attacker cannot inject a forged log line or break the JSON by
 * setting the header. Length is bounded for the same reason.
 */
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export interface RequestIdSources {
  headers?: Headers | { get(name: string): string | null } | null;
}

export function resolveRequestId(sources?: RequestIdSources): string {
  try {
    const headers = sources?.headers;
    if (headers) {
      for (const name of ["x-vercel-id", "x-vercel-request-id", "x-request-id"]) {
        const candidate = headers.get(name);
        if (candidate && ACCEPTABLE_REQUEST_ID.test(candidate.trim())) return candidate.trim();
      }
    }
  } catch {
    /* A header shim that throws is not a reason to fail a request. */
  }
  return randomUUID();
}

/** True when a candidate id would be reused instead of replaced. Used by the tests. */
export function isAcceptableRequestId(candidate: string): boolean {
  return ACCEPTABLE_REQUEST_ID.test(candidate);
}

const SERVICE = "easylearn";
const DEPLOYMENT =
  process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";

/**
 * Write one structured line. Never throws, never returns anything a caller could act
 * on, and always terminates — an error inside the logger cannot escape into a request.
 */
export function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  try {
    if (!shouldLog(level)) return;

    const record = {
      level,
      /* A timestamp is added here rather than left to the platform so that a line
         copied out of the dashboard keeps its ordering. */
      time: new Date().toISOString(),
      service: SERVICE,
      env: DEPLOYMENT,
      msg: redactText(String(message ?? "")),
      ...(redactValue(fields) as Record<string, unknown>),
    };

    const line = JSON.stringify(record);

    /* Errors and warnings go to stderr so a log platform can route them separately
       without parsing JSON, and so `next dev` keeps colouring handled errors red. */
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch (error) {
    /* The last resort. Deliberately does not call `redactValue` (it may be the thing
       that failed) and does not interpolate the original message (it may be the secret).
       A fixed line still tells an operator that logging itself is broken. */
    try {
      console.error(`[${SERVICE}] log emit failed (${level}); a log record was dropped`);
    } catch {
      /* Nothing left to do. Silently continuing is correct: the request matters more. */
    }
  }
}

export const log = {
  debug(message: string, fields?: LogFields): void {
    emit("debug", message, fields);
  },
  info(message: string, fields?: LogFields): void {
    emit("info", message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    emit("warn", message, fields);
  },
  error(message: string, fields?: LogFields): void {
    emit("error", message, fields);
  },
};

/**
 * Serialise an error for a log line without leaking anything.
 *
 * Kept separate from `redactValue` so the shape is stable for alert rules: every
 * error line carries `error.name`, `error.message` and, when the library supplied one,
 * `error.code` (`23505`, `55P03`, `ECONNREFUSED`). Alerting on `error.code` is what
 * makes the log useful; alerting on message text is brittle.
 */
export function describeError(error: unknown): Record<string, unknown> {
  const redacted = redactValue(error);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

/**
 * Time a unit of work and log its outcome at `error` when it throws, `warn` when the
 * caller degraded, and `info` on success. Returns whatever `run` returns; rethrows
 * whatever `run` throws, after logging — it never swallows.
 */
export async function withLoggedSpan<T>(
  fields: LogFields & { event: string; route?: string },
  run: () => Promise<T>,
  options?: { degraded?: (result: T) => boolean }
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    const degraded = options?.degraded?.(result) ?? false;
    emit(degraded ? "warn" : "info", fields.event, {
      ...fields,
      outcome: degraded ? "degraded" : "ok",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    emit("error", fields.event, {
      ...fields,
      outcome: "error",
      durationMs: Date.now() - startedAt,
      error: describeError(error),
    });
    throw error;
  }
}
