/**
 * JWT secret policy tests.
 *
 * The JWT secret is the root of trust for every session token EasyLearn issues: anyone
 * who knows it can mint a token for any user in any school. These tests pin the policy
 * that decides whether a configured secret is usable, and — most importantly — they
 * prove that the policy is enforced at the SIGNING/VERIFICATION CHOKEPOINT rather than
 * only in the routes that happen to remember to check it.
 *
 * Every test here is a regression test: each one fails against the pre-hardening
 * behaviour (a route-level "JWT_SECRET is required" check that accepted a 1-character
 * secret, or a chokepoint that only rejected an empty secret).
 */

import assert from "assert";
import crypto from "crypto";
import {
  describeJwtSecretProblem,
  isJwtSecretAcceptable,
  assertJwtSecretIsUsable,
  isJwtSecretConfigurationError,
  JwtSecretConfigurationError,
  JWT_SECRET_MIN_LENGTH,
  JWT_SECRET_MIN_DISTINCT_CHARACTERS,
} from "@/lib/jwt-policy";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    });
}

const ORIGINAL_ENV = { ...process.env };

function setSecret(value: string | undefined) {
  delete process.env.JWT_SECRET;
  delete process.env.AUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;
  if (value !== undefined) process.env.JWT_SECRET = value;
}

function randomSecret(): string {
  return crypto.randomBytes(48).toString("base64");
}

async function main() {
  console.log("🔑 Running JWT secret policy tests\n");

  await test("Policy: a missing secret is rejected with a 'missing' reason", () => {
    const problem = describeJwtSecretProblem(undefined);
    assert.ok(problem, "expected a problem for an undefined secret");
    assert.strictEqual(problem.code, "missing");
  });

  await test("Policy: an empty secret is rejected with a 'missing' reason", () => {
    const problem = describeJwtSecretProblem("");
    assert.ok(problem, "expected a problem for an empty secret");
    assert.strictEqual(problem.code, "missing");
  });

  await test("Policy: a whitespace-only secret is rejected with a 'missing' reason", () => {
    const problem = describeJwtSecretProblem("   \t  ");
    assert.ok(problem, "expected a problem for a whitespace-only secret");
    assert.strictEqual(problem.code, "missing");
  });

  await test("Policy: the problem message never contains the secret", () => {
    const secret = "short";
    const problem = describeJwtSecretProblem(secret);
    assert.ok(problem);
    assert.ok(
      !problem.message.includes(secret),
      `the problem message must not echo the secret: ${problem.message}`
    );
  });

  await test("Policy: known placeholders are rejected", () => {
    const placeholders = [
      "secret",
      "changeme",
      "change-me",
      "your-secret-here",
      "please-change-me",
      "replace-me",
      "supersecret",
      "development",
      "production",
      "test",
      "password",
      "easylearn",
      "jwt-secret",
      "signing-key",
      "session-secret",
      "not-a-secret",
      "letmein",
      "qwerty",
      "TODO",
      "  ChAngEmE  ",
    ];
    for (const placeholder of placeholders) {
      const problem = describeJwtSecretProblem(placeholder);
      assert.ok(
        problem,
        `expected placeholder ${JSON.stringify(placeholder)} to be rejected`
      );
      assert.strictEqual(
        problem.code,
        "placeholder",
        `expected ${JSON.stringify(placeholder)} to be rejected as a placeholder, got ${problem.code}`
      );
    }
  });

  await test("Policy: the placeholder published in .env.example is rejected", () => {
    // This exact value is what a developer gets when they copy .env.example verbatim.
    // It must never be accepted, otherwise the repository ships a working default key.
    const published = "your-jwt-secret-must-be-at-least-32-characters-long";
    assert.ok(published.length >= JWT_SECRET_MIN_LENGTH, "the example is long enough to pass a length check");
    const problem = describeJwtSecretProblem(published);
    assert.ok(problem, "the .env.example placeholder must be rejected");
    assert.strictEqual(problem.code, "placeholder");
  });

  await test("Policy: the development secret published in CI is rejected", () => {
    const published = "ci-only-not-a-production-secret-at-least-32-characters";
    assert.ok(published.length >= JWT_SECRET_MIN_LENGTH, "the CI value is long enough to pass a length check");
    const problem = describeJwtSecretProblem(published);
    assert.ok(problem, "the CI development secret must be rejected");
    assert.strictEqual(problem.code, "placeholder");
  });

  await test("Policy: a secret shorter than the minimum length is rejected", () => {
    const problem = describeJwtSecretProblem("aB3$xY9!zQ2@mN7&pL4*");
    assert.ok(problem, "expected a short secret to be rejected");
    assert.strictEqual(problem.code, "too_short");
  });

  await test("Policy: a secret of exactly the minimum length is accepted", () => {
    // 32 characters, all distinct enough for the diversity rule.
    const secret = "aB3$xY9!zQ2@mN7&pL4*wR8^jK5%hD1=";
    assert.strictEqual(secret.length, JWT_SECRET_MIN_LENGTH);
    assert.strictEqual(describeJwtSecretProblem(secret), null);
  });

  await test("Policy: a single repeated character is rejected as 'repeated_character'", () => {
    const problem = describeJwtSecretProblem("a".repeat(48));
    assert.ok(problem, "expected a repeated-character secret to be rejected");
    assert.strictEqual(problem.code, "repeated_character");
  });

  await test("Policy: a low-diversity secret is rejected as 'low_diversity'", () => {
    // Two distinct characters, long enough to pass the length rule.
    const problem = describeJwtSecretProblem("ab".repeat(24));
    assert.ok(problem, "expected a low-diversity secret to be rejected");
    assert.strictEqual(problem.code, "low_diversity");
  });

  await test("Policy: a run of digits is rejected as a periodic pattern", () => {
    // 32 characters, 10 distinct characters, long enough to pass the length rule and
    // diverse enough to pass the diversity rule — but it is the digit cycle repeated,
    // so it carries almost no entropy. The periodicity rule is what catches it.
    const problem = describeJwtSecretProblem("12345678901234567890123456789012");
    assert.ok(problem, "expected a digit run to be rejected");
    assert.strictEqual(problem.code, "periodic");
  });

  await test("Policy: a repeated block is rejected", () => {
    const periodic = [
      "ab".repeat(24),
      "easylearneasylearneasylearneasylearn",
      "q7Zx".repeat(12),
      "1234567890".repeat(4),
    ];
    // Depending on how many distinct characters the block has, the policy reports either
    // "low_diversity" or "periodic". Both are refusals; what matters is that a repeated
    // block never passes.
    const weakCodes = new Set(["low_diversity", "periodic", "repeated_character"]);
    for (const secret of periodic) {
      const problem = describeJwtSecretProblem(secret);
      assert.ok(problem, `expected ${JSON.stringify(secret)} to be rejected`);
      assert.ok(
        weakCodes.has(problem.code),
        `expected ${JSON.stringify(secret)} to be rejected as a weak shape, got ${problem.code}`
      );
    }
  });

  await test("Policy: a secret with exactly the minimum distinct characters is accepted", () => {
    // Exactly JWT_SECRET_MIN_DISTINCT_CHARACTERS distinct characters, long enough, and
    // deliberately NOT a repetition of any shorter block (the tail breaks the cycle).
    const secret = "aB3$xY9!zQaB3$xY9!zQaB3$xY9!zQzB";
    assert.strictEqual(secret.length, 32);
    assert.strictEqual(new Set(secret).size, JWT_SECRET_MIN_DISTINCT_CHARACTERS);
    assert.strictEqual(
      describeJwtSecretProblem(secret),
      null,
      `a non-periodic secret on the diversity boundary must be accepted: ${
        describeJwtSecretProblem(secret)?.message
      }`
    );
  });

  await test("Policy: a secret with one distinct character below the minimum is rejected", () => {
    const secret = "aB3$xY9!zaB3$xY9!zaB3$xY9!zaB3$x";
    assert.strictEqual(secret.length, 32);
    assert.strictEqual(new Set(secret).size, JWT_SECRET_MIN_DISTINCT_CHARACTERS - 1);
    const problem = describeJwtSecretProblem(secret);
    assert.ok(problem, "expected a below-boundary diversity secret to be rejected");
    assert.strictEqual(problem.code, "low_diversity");
  });

  await test("Policy: 200 randomly generated secrets are all accepted", () => {
    for (let i = 0; i < 200; i++) {
      const secret = randomSecret();
      assert.ok(
        isJwtSecretAcceptable(secret),
        `a randomly generated secret must be accepted, got ${describeJwtSecretProblem(secret)?.message}`
      );
    }
  });

  await test("Policy: a randomly generated hex secret is accepted", () => {
    const secret = crypto.randomBytes(32).toString("hex");
    assert.strictEqual(secret.length, 64);
    assert.strictEqual(describeJwtSecretProblem(secret), null);
  });

  await test("Policy: surrounding whitespace is trimmed, not rejected", () => {
    const secret = randomSecret();
    assert.strictEqual(describeJwtSecretProblem(`  ${secret}  `), null);
  });

  await test("Policy: a secret containing the word 'secret' is still accepted", () => {
    // Placeholder detection is exact-match, not substring: a strong random secret may
    // legitimately contain "secret" and must not be rejected for that.
    const secret = `${randomSecret()}secret${randomSecret()}`;
    assert.ok(secret.length >= JWT_SECRET_MIN_LENGTH);
    assert.strictEqual(describeJwtSecretProblem(secret), null);
  });

  await test("assertJwtSecretIsUsable throws a typed configuration error", () => {
    assert.throws(
      () => assertJwtSecretIsUsable("short"),
      (error: unknown) => {
        assert.ok(error instanceof JwtSecretConfigurationError);
        assert.ok(isJwtSecretConfigurationError(error));
        return true;
      }
    );
  });

  await test("assertJwtSecretIsUsable does not throw for a valid secret", () => {
    assert.doesNotThrow(() => assertJwtSecretIsUsable(randomSecret()));
  });

  // ── The chokepoint: the policy must be enforced where tokens are signed and verified ──

  await test("Chokepoint: createToken refuses to sign with a weak secret", async () => {
    setSecret("short");
    const { createToken } = await import("@/lib/auth");
    await assert.rejects(
      () =>
        createToken({
          userId: "00000000-0000-4000-8000-000000000001",
          role: "learner",
        }),
      (error: unknown) => {
        assert.ok(
          isJwtSecretConfigurationError(error),
          `expected a JWT secret configuration error, got ${String(error)}`
        );
        return true;
      }
    );
  });

  await test("Chokepoint: createToken refuses to sign with a placeholder secret", async () => {
    setSecret("changeme");
    const { createToken } = await import("@/lib/auth");
    await assert.rejects(
      () =>
        createToken({
          userId: "00000000-0000-4000-8000-000000000001",
          role: "learner",
        }),
      (error: unknown) => isJwtSecretConfigurationError(error)
    );
  });

  await test("Chokepoint: verifyToken refuses to verify with a weak secret", async () => {
    setSecret("short");
    const { verifyToken } = await import("@/lib/auth");
    await assert.rejects(
      () => verifyToken("not.a.real.token"),
      (error: unknown) => isJwtSecretConfigurationError(error)
    );
  });

  await test("Chokepoint: a valid random secret signs and verifies a token", async () => {
    setSecret(randomSecret());
    const { createToken, verifyToken } = await import("@/lib/auth");
    const token = await createToken({
      userId: "00000000-0000-4000-8000-000000000001",
      email: "learner@example.test",
      role: "learner",
    });
    assert.ok(token, "a token must be produced");
    const payload = await verifyToken(token);
    assert.ok(payload, "the token must verify");
    assert.strictEqual(payload.userId, "00000000-0000-4000-8000-000000000001");
  });

  await test("Chokepoint: the env helper and the policy agree on every verdict", async () => {
    const { getJwtConfigurationProblem } = await import("@/lib/env");
    const samples = [
      undefined,
      "",
      "  ",
      "short",
      "changeme",
      "your-jwt-secret-must-be-at-least-32-characters-long",
      "a".repeat(48),
      "ab".repeat(24),
      randomSecret(),
    ];
    for (const sample of samples) {
      setSecret(sample);
      const fromPolicy = describeJwtSecretProblem(sample);
      const fromEnv = getJwtConfigurationProblem();
      if (fromPolicy) {
        assert.ok(fromEnv, `the env helper must report the same problem for ${JSON.stringify(sample)}`);
        assert.strictEqual(
          fromEnv,
          fromPolicy.message,
          `the env helper and the policy must report the same message for ${JSON.stringify(sample)}`
        );
      } else {
        assert.strictEqual(
          fromEnv,
          null,
          `the env helper must accept the same secret the policy accepts: ${JSON.stringify(sample)}`
        );
      }
    }
  });

  process.env.JWT_SECRET = ORIGINAL_ENV.JWT_SECRET;
  process.env.AUTH_SECRET = ORIGINAL_ENV.AUTH_SECRET;
  process.env.NEXTAUTH_SECRET = ORIGINAL_ENV.NEXTAUTH_SECRET;

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log(`✅ ${passed} JWT secret policy tests passed`);
}

main().catch((error: unknown) => {
  console.error("JWT secret policy suite failed to run:", error);
  process.exitCode = 1;
});
