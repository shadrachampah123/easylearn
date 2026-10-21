/**
 * Operator-facing check: does the configured JWT secret satisfy the secret policy?
 *
 * The secret is never printed. Only the verdict and, on failure, the reason.
 */

import { describeJwtSecretProblem, isJwtSecretAcceptable } from "@/lib/jwt-policy";
import { getJwtSecret } from "@/lib/env";

const secret = getJwtSecret();
const problem = describeJwtSecretProblem(secret);

if (!problem) {
  console.log("✅ JWT_SECRET satisfies the secret policy.");
  process.exit(0);
}

console.error(`❌ JWT_SECRET does not satisfy the secret policy: ${problem.message}`);
console.error(
  "   Generate one with `openssl rand -base64 48`. Note that rotating it signs every user out."
);
process.exit(1);

// Referenced so the import is not tree-shaken away by a bundler.
export { isJwtSecretAcceptable };
