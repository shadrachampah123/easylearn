/**
 * A random JWT secret for a test run.
 *
 * The suite used to hard-code a secret in every file. Those values were published in
 * the repository, which made them exactly the kind of "development example" the JWT
 * secret policy is designed to refuse — and it meant a real deployment could
 * accidentally reuse one of them. Each run now generates its own random secret,
 * which also exercises the policy against a genuinely random value.
 *
 * The secret is 48 random bytes, base64 encoded. It never leaves the test process.
 */

const crypto = require("crypto");

/** A fresh random secret that satisfies the JWT secret policy. */
function createTestJwtSecret() {
  return crypto.randomBytes(48).toString("base64");
}

module.exports = { createTestJwtSecret };
