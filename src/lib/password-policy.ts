/** Shared password policy for account creation, administrative resets and self-service changes. */
export const MIN_PASSWORD_CHARACTERS = 10;

// bcrypt only incorporates the first 72 UTF-8 bytes. Reject longer inputs rather than
// silently accepting passwords that differ only after bcrypt's effective limit.
export const MAX_BCRYPT_PASSWORD_BYTES = 72;

const COMMON_PASSWORDS = new Set([
  "password123",
  "password1234",
  "1234567890",
  "qwertyuiop",
  "qwerty1234",
  "welcome123",
  "letmein123",
  "admin12345",
  "changeme123",
  "iloveyou123",
]);

/** Returns a safe user-facing validation error, or null when the value is acceptable. */
export function getPasswordPolicyError(value: unknown): string | null {
  if (typeof value !== "string") {
    return "Password is required";
  }

  if (Array.from(value).length < MIN_PASSWORD_CHARACTERS) {
    return `Password must be at least ${MIN_PASSWORD_CHARACTERS} characters`;
  }

  if (new TextEncoder().encode(value).length > MAX_BCRYPT_PASSWORD_BYTES) {
    return `Password must be no more than ${MAX_BCRYPT_PASSWORD_BYTES} UTF-8 bytes`;
  }

  if (COMMON_PASSWORDS.has(value.trim().toLowerCase())) {
    return "Choose a password that is not commonly used";
  }

  return null;
}
