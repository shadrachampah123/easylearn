/** Type declarations for the CommonJS test helper `tests/helpers/test-secret.js`. */

/**
 * Returns a fresh random JWT secret (48 random bytes, base64 encoded) that satisfies
 * the JWT secret policy in `src/lib/jwt-policy.ts`.
 */
export function createTestJwtSecret(): string;
