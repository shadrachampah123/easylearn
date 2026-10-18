import assert from "assert";
import { assignmentPolicyDecision } from "@/lib/assignment-policy";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${(error as Error).message}`);
    failed += 1;
  }
}

console.log("📝 Assignment-question authorization policy tests\n");

test("teachers receive full content only for ownership or explicit management authorization", () => {
  assert.strictEqual(assignmentPolicyDecision({ role: "teacher", ownsAssignment: true }), "manage-full");
  assert.strictEqual(
    assignmentPolicyDecision({ role: "teacher", explicitlyAuthorized: true }),
    "manage-full"
  );
  assert.strictEqual(assignmentPolicyDecision({ role: "teacher" }), "denied");
  assert.strictEqual(
    assignmentPolicyDecision({ role: "teacher", ownsAssignment: true, sameSchool: false }),
    "denied"
  );
});

test("school administrators and head teachers receive oversight access", () => {
  for (const role of ["school_admin", "head_teacher"]) {
    assert.strictEqual(assignmentPolicyDecision({ role }), "oversight-full");
  }
});

test("learners need publication and class enrollment and receive content only", () => {
  assert.strictEqual(
    assignmentPolicyDecision({ role: "learner", published: true, enrolled: true }),
    "published-content"
  );
  assert.strictEqual(
    assignmentPolicyDecision({ role: "learner", published: false, enrolled: true }),
    "denied"
  );
  assert.strictEqual(
    assignmentPolicyDecision({ role: "learner", published: true, enrolled: false }),
    "denied"
  );
});

test("parents need publication, enrollment, and an explicit parent-learner link", () => {
  assert.strictEqual(
    assignmentPolicyDecision({ role: "parent", published: true, enrolled: true, parentLinked: true }),
    "published-content"
  );
  assert.strictEqual(
    assignmentPolicyDecision({ role: "parent", published: true, enrolled: true, parentLinked: false }),
    "denied"
  );
  assert.strictEqual(
    assignmentPolicyDecision({ role: "parent", published: false, enrolled: true, parentLinked: true }),
    "denied"
  );
});

test("unknown roles are denied by default", () => {
  assert.strictEqual(assignmentPolicyDecision({ role: "guest" }), "denied");
  assert.strictEqual(assignmentPolicyDecision({ role: "super_admin", sameSchool: false }), "denied");
});

if (failed > 0) process.exitCode = 1;
else console.log(`\n✅ ${passed} assignment authorization policy tests passed`);
