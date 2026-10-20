/**
 * JWT secret policy.
 *
 * The secret used to sign and verify EasyLearn session tokens is the single most
 * sensitive value in the deployment: anyone who knows it can mint a token for any
 * user id, in any school, and every API route trusts that token. This module is the
 * ONE place that decides whether a configured secret is acceptable, so the rule
 * cannot be bypassed by adding a new route that forgets to call it.
 *
 * ── What this policy does and does not prove ──────────────────────────────────
 * The checks below are a *shape* policy: length, character diversity, and the absence
 * of well-known placeholder values. They are deliberately cheap to evaluate and
 * therefore run on every single token operation.
 *
 * They do NOT prove randomness. A 32-character passphrase built from one dictionary
 * word ("correcthorsebatterystaple" is fine, "easylearn" repeated is not) can satisfy
 * every check here while still being guessable. Length alone is not entropy, and this
 * module does not claim otherwise. The only reliable way to obtain a strong secret is
 * to generate it with a cryptographically secure random source:
 *
 *     openssl rand -base64 48      # 48 random bytes -> 64 base64 characters
 *     node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
 *
 * The policy therefore has two jobs:
 *   1. Stop the obviously-broken deployments (missing, placeholder, too short,
 *      trivially low diversity) from ever signing a token.
 *   2. Refuse to start serving authenticated traffic when the secret does not pass,
 *      so a misconfiguration is a loud, immediate failure rather than a silent
 *      downgrade in cryptographic strength.
 *
 * The secret itself is never included in an error message, a log line, or a health
 * payload. `describeJwtSecretProblem` reports the *reason* only.
 */

/** Minimum accepted length of the configured JWT secret, in characters. */
export const JWT_SECRET_MIN_LENGTH = 32;

/**
 * Minimum number of *distinct* characters the secret must contain.
 *
 * This rejects the classic low-diversity shapes that pass a length check while
 * carrying almost no entropy: a single repeated character, a short cycle
 * ("abababab..."), a run of digits, or a l33tspeak variant of a dictionary word.
 */
export const JWT_SECRET_MIN_DISTINCT_CHARACTERS = 10;

/**
 * Well-known placeholder / example / development values.
 *
 * Compared case-insensitively against the trimmed secret. These are exact values, not
 * substrings: a legitimate randomly generated secret may legitimately contain the
 * word "secret" or "test" somewhere inside it, and rejecting on a substring would
 * reject strong secrets. What must never be accepted is the *whole* secret being a
 * value that is published in this repository, in a tutorial, or in a template.
 */
const JWT_SECRET_PLACEHOLDERS: ReadonlySet<string> = new Set(
  [
    // Generic placeholders
    "secret",
    "supersecret",
    "super-secret",
    "super_secret",
    "my-secret-key",
    "my_secret_key",
    "mysecretkey",
    "s3cr3t",
    "notasecret",
    "not-a-secret",
    "notsecret",
    "changeme",
    "change-me",
    "change_me",
    "changeit",
    "change-it",
    "your-secret-here",
    "your_secret_here",
    "yoursecret-here",
    "your-jwt-secret",
    "your_jwt_secret",
    "please-change-me",
    "please_change_me",
    "replace-me",
    "replace_me",
    "replaceme",
    "todo",
    "tbd",
    "fixme",
    "xxx",
    "placeholder",
    "example",
    "examples",
    "sample",
    "default",
    "dummy",
    "temp",
    "temporary",
    "foobar",
    "foo",
    "bar",
    "baz",
    "qwerty",
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
    "abcdefghijklmnopqrstuvwxyz",
    "abcdefghijklmnopqrstuvwxyzabcdefgh",
    "qwertyuiopasdfghjklzxcvbnm",
    "0123456789012345678901234567890123",
    "letmein",
    "iloveyou",
    "administrator",
    "admin",
    "administrator",
    "password",
    "passw0rd",
    "p@ssw0rd",
    "keyboard-cat",
    "shhh",
    "hush",
    "keyboard cat",
    // Application-specific placeholders
    "easylearn",
    "easylearn-secret",
    "easylearn_secret",
    "easylearnsecret",
    "easylearn-jwt-secret",
    "jwt-secret",
    "jwt_secret",
    "jwtsecret",
    "jwt-signing-key",
    "signing-key",
    "signing_key",
    "signingkey",
    "hmac-secret",
    "hmac_secret",
    "hmacsecret",
    "session-secret",
    "session_secret",
    "sessionsecret",
    "app-secret",
    "app_secret",
    "appsecret",
    "auth-secret",
    "auth_secret",
    "authsecret",
    "encryption-key",
    "encryption_key",
    "encryptionkey",
    // Environment / tooling words that are never a real secret
    "development",
    "dev",
    "production",
    "prod",
    "staging",
    "test",
    "testing",
    "local",
    "localhost",
    // Values published in this repository's own templates and CI configuration
    "your-jwt-secret-must-be-at-least-32-characters-long",
    "ci-only-not-a-production-secret-at-least-32-characters",
  ].map((value) => value.toLowerCase()),
);

export type JwtSecretProblemCode =
  | "missing"
  | "placeholder"
  | "too_short"
  | "low_diversity"
  | "repeated_character"
  | "periodic";

export interface JwtSecretProblem {
  /** Stable, machine-readable reason. Never contains the secret. */
  code: JwtSecretProblemCode;
  /** Human-readable, actionable explanation. Never contains the secret. */
  message: string;
}

/**
 * Detects a secret built by repeating a shorter block.
 *
 * This catches the shapes that satisfy a length check while carrying almost no
 * entropy:
 *
 *     "12345678901234567890123456789012"   (the digit cycle, repeated)
 *     "abababababababababababababababab"     (a two-character cycle)
 *     "easylearneasylearneasylearneasylearn" (a word, repeated)
 *     "q7Zxq7Zxq7Zxq7Zxq7Zxq7Zxq7Zxq7Zx"     (a short block, repeated)
 *
 * A secret whose every character is determined by a repeating block of length `p`
 * has at most `p` characters of real information no matter how long it is, so it is
 * rejected. The final block may be a prefix of the first (that is how the digit
 * cycle above is spelled), so the comparison is done modulo the block length.
 *
 * The period is bounded at half the length, so the block must appear at least
 * twice. This keeps the check from rejecting a genuinely random secret by
 * coincidence: with a 64-character alphabet, the chance that a random 32+ character
 * secret matches some block of length <= half its length is on the order of
 * 10^-16, while the shapes above are detected deterministically.
 */
function isPeriodic(value: string): boolean {
  for (let period = 1; period <= Math.floor(value.length / 2); period++) {
    let matches = true;
    for (let i = period; i < value.length; i++) {
      if (value[i] !== value[i % period]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/**
 * Returns the reason a secret is unusable, or `null` when it passes the policy.
 *
 * The returned message deliberately describes the *requirement* and how to satisfy
 * it, never the value that was supplied.
 */
export function describeJwtSecretProblem(secret: string | undefined | null): JwtSecretProblem | null {
  if (typeof secret !== "string") {
    return {
      code: "missing",
      message:
        "JWT_SECRET is not configured. Generate one with `openssl rand -base64 48` and set it in the deployment environment.",
    };
  }

  const trimmed = secret.trim();

  if (!trimmed) {
    return {
      code: "missing",
      message:
        "JWT_SECRET is not configured. Generate one with `openssl rand -base64 48` and set it in the deployment environment.",
    };
  }

  if (JWT_SECRET_PLACEHOLDERS.has(trimmed.toLowerCase())) {
    return {
      code: "placeholder",
      message:
        "JWT_SECRET is a well-known placeholder or example value. Generate a unique secret with `openssl rand -base64 48` and replace it.",
    };
  }

  if (trimmed.length < JWT_SECRET_MIN_LENGTH) {
    return {
      code: "too_short",
      message: `JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters long. Generate one with \`openssl rand -base64 48\`.`,
    };
  }

  // A secret made of a single repeated character is called out separately so the
  // operator gets an unambiguous explanation rather than a generic diversity error.
  if (/^(.)\1+$/.test(trimmed)) {
    return {
      code: "repeated_character",
      message:
        "JWT_SECRET repeats a single character. Generate one with `openssl rand -base64 48`.",
    };
  }

  const distinct = new Set(trimmed).size;

  if (distinct < JWT_SECRET_MIN_DISTINCT_CHARACTERS) {
    return {
      code: "low_diversity",
      message: `JWT_SECRET must contain at least ${JWT_SECRET_MIN_DISTINCT_CHARACTERS} distinct characters. Generate one with \`openssl rand -base64 48\`.`,
    };
  }

  // A secret that is a repeated block of a shorter string (a digit cycle, a two-character
  // alternation, a word repeated to fill the length) has almost no real entropy even
  // though it satisfies both the length and the diversity rule.
  if (isPeriodic(trimmed)) {
    return {
      code: "periodic",
      message:
        "JWT_SECRET repeats a short pattern and therefore carries very little entropy. Generate one with `openssl rand -base64 48`.",
    };
  }

  return null;
}

/** True when the configured secret satisfies the policy. */
export function isJwtSecretAcceptable(secret: string | undefined | null): boolean {
  return describeJwtSecretProblem(secret) === null;
}

/** Thrown when a token operation is attempted with an unusable JWT secret. */
export class JwtSecretConfigurationError extends Error {
  readonly code: JwtSecretProblemCode;

  constructor(problem: JwtSecretProblem) {
    super(problem.message);
    this.name = "JwtSecretConfigurationError";
    this.code = problem.code;
  }
}

/**
 * Fails loudly when the configured secret is unusable.
 *
 * Called from the single signing/verification chokepoint so that *no* code path can
 * sign or verify a token with a secret that has not passed the policy. The thrown
 * error carries the reason but never the value.
 */
export function assertJwtSecretIsUsable(secret: string | undefined | null): void {
  const problem = describeJwtSecretProblem(secret);
  if (problem) {
    throw new JwtSecretConfigurationError(problem);
  }
}

/** True when the error is a JWT secret configuration failure (not a runtime fault). */
export function isJwtSecretConfigurationError(error: unknown): error is JwtSecretConfigurationError {
  return (
    error instanceof JwtSecretConfigurationError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: string }).name === "JwtSecretConfigurationError")
  );
}
