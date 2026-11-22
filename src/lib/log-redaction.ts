/**
 * Secret and personal-data redaction for server logs (H-2).
 *
 * Every value written to a log passes through here first. The rule is a deny-list
 * applied to *both* key names and free text, because a log line is built from three
 * different kinds of input and only one of them is a known object shape:
 *
 *   1. structured fields we choose (`{ route, status, userId }`);
 *   2. error objects from the database, the JWT library, the S3 signer or `fetch`,
 *      whose message text is written by a library and may quote a connection string;
 *   3. request data an attacker controls (`path`, user agent, a thrown string).
 *
 * A redactor that only scrubbed known keys would leak case 2 and 3. So there are two
 * passes: key-based replacement on object graphs, and pattern-based replacement on every
 * resulting string. Both are exercised in `tests/logging-redaction.test.ts`, including a
 * positive control that proves an unredacted value would survive the surrounding
 * pipeline — otherwise "no secret in the output" could pass for the wrong reason.
 *
 * FAILURE MODE: redaction can never throw. A logging path that raises turns a handled
 * error into an unhandled one, and a thrown error inside a catch block is exactly how a
 * diagnostic becomes an outage. Every entry point is wrapped and falls back to a fixed
 * placeholder rather than propagating.
 */

import { createHash } from "node:crypto";

/** Replacement text for anything redacted. Fixed, so a grep finds every occurrence. */
export const REDACTED = "[redacted]";

/**
 * Object keys whose *value* is a secret, a credential or personal data.
 *
 * Compared after normalisation (lowercase, non-alphanumerics removed), so
 * `password_hash`, `passwordHash`, `X-Api-Key` and `authorization` all match without
 * listing every spelling.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/,
  /passwd/,
  /secret/,
  /token/,
  /authorization/,
  /authheader/,
  /cookie/,
  /apikey/,
  /accesskey/,
  /privatekey/,
  /credential/,
  /sessionid/,
  /csrf/,
  /signature/,
  /* Personal data. Names, addresses and phone numbers are not credentials, but
     they are the fields an operator would not want shipped to a third-party log
     store, and they are the ones a request body would carry (I-R1's neighbour). */
  /email/,
  /firstname/,
  /lastname/,
  /fullname/,
  /phone/,
  /address/,
  /dateofbirth/,
  /dob/,
  /guardian/,
  /^ip(address)?$/,
  /clientip/,
  /remoteip/,
];

/** Normalise a key for comparison: lowercase, letters and digits only. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (!normalised) return false;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalised));
}

/**
 * Text patterns for secrets that arrive as plain strings.
 *
 * Order matters: the connection-string rule runs before the generic
 * `key=value` rule, because `postgres://user:pass@host` contains `user:pass` in the
 * authority and a later rule would leave the user name behind.
 */
const TEXT_PATTERNS: readonly { pattern: RegExp; replace: (match: string, ...groups: string[]) => string }[] = [
  /* PostgreSQL/MySQL connection strings, from pg, pg-connection-string, a dotenv
     parse error or a Drizzle error. The scheme is kept — it is diagnostic and not
     secret — and the credentials and host are dropped, because the host names the
     database, which is infrastructure detail. */
  {
    pattern: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s"'`\\]*/gi,
    replace: (_match, scheme: string) => `${scheme}://${REDACTED}`,
  },
  /* JWTs: three base64url segments whose first decodes to a JSON header. Anchored on
     `eyJ` so an ordinary sentence with two dots is never touched. */
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
    replace: () => REDACTED,
  },
  /* Bearer / Basic credentials anywhere in a line, including inside an error the
     platform formatted from request headers. */
  {
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_match, scheme: string) => `${scheme} ${REDACTED}`,
  },
  /* A `Cookie:` / `Set-Cookie:` header, in either the `name=value; name2=value2` shape
     a header dump produces or the quoted shape a serializer produces. */
  {
    pattern: /\b((?:set-)?cookie"?\s*[:=]\s*)("[^"]*"|[^\r\n]{1,512})/gi,
    replace: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  /* A bare session cookie `name=value` with NO header prefix — the shape a hand-written
     log line or a cookie library error produces. Without this rule the value survives,
     because there is no `Cookie:` to anchor on. Found by this work's own suite. */
  {
    pattern:
      /\b((?:__Host-|__Secure-)?(?:easylearn|next-auth|session|sess|connect\.sid|csrftoken|csrf)[a-z0-9._-]*(?:\.[a-z0-9_-]+)?=)[^;\s,"']{4,}/gi,
    replace: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  /* An `Authorization:` header with no recognised scheme. */
  {
    pattern: /\b(authorization"?\s*[:=]\s*)("[^"]*"|[^\s,;]{4,})/gi,
    replace: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  /* AWS/R2 access key ids. `AKIA`/`ASIA`/`AIDA`/`AROA` are the documented prefixes. */
  {
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{12,}\b/g,
    replace: () => REDACTED,
  },
  /* Signed-URL query parameters. A presigned URL *is* a credential: the signature alone
     authorises the request. The parameter name is kept so an operator can see that a
     signed URL was involved; the value is dropped. */
  {
    pattern:
      /([?&](?:x-amz|x-goog|sig|signature|token|access_token|api_key|apikey|key)(?:-|_)?(?:signature|credential|security-token|expires|algorithm|signedheaders|access_key_id)?=)[^&\s"'#<>]*/gi,
    replace: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  /* Email addresses in free text — personal data, and the class that reaches a log by
     accident most often (a driver message, a validation error, a query fragment).
     `redactValue` catches one in a field named `email`; only a text rule catches one
     inside a sentence.

     THE DOMAIN MUST HAVE A DOT. This started as "a local part, an @, and a dotted
     domain", and the dot was the load-bearing part: without it every `src/app/page.tsx`
     path in a stack trace matched (`app@page`), which both destroyed the most useful part
     of an error log and redacted the very file names an operator needs. Requiring at
     least one dot after the @ fixes that, and two-letter TLDs still count — `.gh`, `.uk`,
     `.co`, `.ng` are real, and `.gh` in particular is this deployment's own domain.

     What it leaves alone, deliberately: `react@19.2.6` (no dotted domain) and
     `src/app/page.tsx` (no dotted domain after the @). */
  {
    pattern: /\b[A-Za-z0-9._%+-]{2,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g,
    replace: (match: string) => {
      const at = match.lastIndexOf("@");
      /* The regex already requires a dotted domain, so any match here is address-shaped.
         The local-part length is the only remaining guard, and it is what keeps a
         single-character token out. */
      return match.slice(0, at).length >= 2 ? REDACTED : match;
    },
  },
  /* A long, high-entropy token with no key name adjacent to it at all — the case the
     key-anchored rules structurally cannot cover, because the value arrives as a bare
     string. Found by this work's suite: `R2SecretAccessKey/with+special=chars0123456789`
     survived every key-anchored rule.
     The heuristic is "32+ characters from a token alphabet, containing at least one
     digit and one letter, excluding a UUID". False positives cost a redacted word; false
     negatives cost a credential. */
  {
    pattern: /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/.=-]{32,}(?![A-Za-z0-9_+/=-])/g,
    replace: (match: string) =>
      /[0-9]/.test(match) && /[A-Za-z]/.test(match) && !/^[0-9a-f-]{36}$/i.test(match) ? REDACTED : match,
  },
  /* `key=value` / `key: value` where the KEY is a secret by name — the last line of
     defence for a value the other rules missed because the key made it obvious. */
  {
    pattern:
      /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]{1,512})/gi,
    replace: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
];

/**
 * Run every text pattern over a string.
 *
 * Exported separately from `redactValue` so the health endpoint and the request
 * logger can sanitise a message they built themselves without re-walking an object.
 */
export function redactText(input: string): string {
  if (typeof input !== "string" || input.length === 0) return "";
  try {
    return TEXT_PATTERNS.reduce<string>((text, rule) => text.replace(rule.pattern, rule.replace as never), input);
  } catch {
    /* A malformed pattern or a pathological input must not break logging. */
    return REDACTED;
  }
}

/**
 * Structural limits. A log line has to stay small: an unbounded error object or a
 * cyclic graph is its own outage (memory, log-ingest cost, unreadable output).
 */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 80;
const MAX_STRING_LENGTH = 2_000;

/**
 * Redact one value of arbitrary shape into something JSON-serialisable.
 *
 * - keys matching `isSensitiveKey` become `REDACTED` (the key is kept, so an operator
 *   can see that a password *was* present in the payload without seeing it);
 * - every remaining string is still passed through `redactText`, because a secret can
 *   be the value of a perfectly innocent key (`message`, `url`, `detail`);
 * - `Error` instances become `{ name, message, code, stack? }` plus a redacted `cause`;
 * - depth, breadth and string length are bounded, and cycles become `[circular]`.
 *
 * Never throws. The `catch` is load-bearing: this function is called from `catch`
 * blocks and from the instrumentation hook.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  try {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      return redactText(value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value);
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol") return value.toString();
    if (typeof value === "function") return "[function]";

    if (value instanceof Date) return value.toISOString();
    if (value instanceof URL) return redactText(value.toString());

    if (depth >= MAX_DEPTH) return "[depth-limit]";

    if (typeof value === "object") {
      const asObject = value as object;
      if (seen.has(asObject)) return "[circular]";
      seen.add(asObject);

      if (value instanceof Error) {
        const errorLike = value as Error & { code?: unknown; cause?: unknown; errno?: unknown };
        const out: Record<string, unknown> = {
          name: errorLike.name,
          message: redactText(String(errorLike.message ?? "")),
        };
        if (errorLike.code !== undefined) out.code = typeof errorLike.code === "string" ? redactText(errorLike.code) : errorLike.code;
        if (errorLike.errno !== undefined) out.errno = errorLike.errno;
        if (errorLike.cause !== undefined) out.cause = redactValue(errorLike.cause, depth + 1, seen);
        if (typeof errorLike.stack === "string") out.stack = redactText(errorLike.stack);
        return out;
      }

      if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen));
        if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more]`);
        return items;
      }

      const output: Record<string, unknown> = {};
      const keys = Object.keys(value as Record<string, unknown>);
      for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
        if (isSensitiveKey(key)) {
          /* Keep the key, drop the value: an operator needs to know the field was
             there (for example that a request body carried a password) but not what
             it was. */
          output[key] = REDACTED;
          continue;
        }
        /* A THROWING GETTER IS A REAL CASE, not a hypothetical: `pg` errors carry
           lazily-built properties, and a proxy or an ORM row can too. Reading one used
           to abort the whole walk and return the bare placeholder, losing every other
           field on the object — which is worse than losing one field. Each property is
           therefore read in isolation. */
        try {
          output[key] = redactValue((value as Record<string, unknown>)[key], depth + 1, seen);
        } catch {
          output[key] = "[unreadable]";
        }
      }
      if (keys.length > MAX_OBJECT_KEYS) output["[truncated]"] = `${keys.length - MAX_OBJECT_KEYS} keys omitted`;
      return output;
    }

    return String(value);
  } catch {
    return REDACTED;
  }
}

/**
 * A weak, non-reversible fingerprint used to correlate logs without storing an
 * identifying value.
 *
 * Used for the personal data that must not appear in a log but *is* useful to group
 * ("the same account failed three times"). 12 hex characters of SHA-256 over a
 * redaction-time salt is not a security boundary; it is a debuggability aid, and the
 * salt makes a rainbow-table lookup of a known email address useless.
 */
export function fingerprint(value: string, salt = "easylearn-log-fingerprint"): string {
  try {
    /* A static import keeps this module's graph analysable and avoids a dynamic
       `require` in code that also runs under `next build`. The instrumentation hook is
       Node-only, and every caller of `fingerprint` is a server module. */
    return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 12);
  } catch {
    return "unavailable";
  }
}
