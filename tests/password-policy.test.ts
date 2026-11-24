import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getPasswordPolicyError, MAX_BCRYPT_PASSWORD_BYTES, MIN_PASSWORD_CHARACTERS } from "../src/lib/password-policy";

const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

let passed = 0;

function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✅ PASS: ${name}`);
}

test("enforces the shared minimum length", () => {
  assert.equal(getPasswordPolicyError("short123"), `Password must be at least ${MIN_PASSWORD_CHARACTERS} characters`);
  assert.equal(getPasswordPolicyError("long-enough-passphrase"), null);
});

test("rejects common passwords without case or surrounding-space bypasses", () => {
  assert.match(getPasswordPolicyError("Password123") ?? "", /not commonly used/i);
  assert.match(getPasswordPolicyError("  welcome123  ") ?? "", /not commonly used/i);
  assert.equal(getPasswordPolicyError("welcome123-with-unique-phrase"), null);
});

test("rejects passwords that exceed bcrypt's effective UTF-8 input limit", () => {
  assert.equal(getPasswordPolicyError("a".repeat(MAX_BCRYPT_PASSWORD_BYTES)), null);
  assert.match(getPasswordPolicyError("a".repeat(MAX_BCRYPT_PASSWORD_BYTES + 1)) ?? "", /72 UTF-8 bytes/);
  assert.match(getPasswordPolicyError("🙂".repeat(19)) ?? "", /72 UTF-8 bytes/);
});

test("rejects non-string inputs safely", () => {
  assert.equal(getPasswordPolicyError(null), "Password is required");
  assert.equal(getPasswordPolicyError(1234567890), "Password is required");
});

test("all password write paths enforce policy and mark administrative credentials temporary", () => {
  const createRoute = read("src/app/api/users/route.ts");
  const resetRoute = read("src/app/api/users/[id]/route.ts");
  const changeRoute = read("src/app/api/auth/change-password/route.ts");
  const usersUi = read("src/components/admin/UsersManager.tsx");

  assert.match(createRoute, /getPasswordPolicyError\(password\)/);
  assert.match(resetRoute, /getPasswordPolicyError\(password\)/);
  assert.match(changeRoute, /getPasswordPolicyError\(newPassword\)/);
  assert.match(createRoute, /mustChangePassword:\s*true/);
  assert.match(resetRoute, /mustChangePassword:\s*true/);
  assert.doesNotMatch(createRoute, /generatedPassword/);
  assert.match(usersUi, /password:\s*newPassword/);
});

console.log(`\n📊 Results: ${passed} passed, 0 failed`);
