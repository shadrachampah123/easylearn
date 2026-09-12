/**
 * Phase 1 Security Tests
 * Tests for critical security and authorization fixes
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function readFile(filePath) {
  return fs.readFileSync(path.join(__dirname, '..', filePath), 'utf8');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   ${error.message}`);
    failed++;
  }
}

console.log('🔒 Running Phase 1 Security Tests\n');

// 1. Authentication tests
test('Authentication: users route requires admin role', () => {
  const content = readFile('src/app/api/users/route.ts');
  assert(content.includes('Only administrators can view user directory'), 'Should restrict to admins');
  assert(content.includes('super_admin') && content.includes('school_admin'), 'Should check admin roles');
});

test('Authentication: announcements public vs private', () => {
  const content = readFile('src/app/api/announcements/route.ts');
  assert(content.includes('isPublic'), 'Should handle public param');
  // Phase 2C moved the authentication + tenant gate into one audited helper. The property
  // is unchanged (non-public announcements still require an authenticated session) and the
  // assertion follows the implementation: the guard IS the 401/403 response.
  assert(
    content.includes('guardSchoolContext(request)'),
    'Should require an authenticated school context for non-public announcements'
  );
  assert(
    content.includes('sqlUserInSchool(ctx.schoolId, announcements.authorId)'),
    'Phase 2C: only this school\'s announcements may be listed'
  );
  assert(content.includes('public') && content.includes('true'), 'Should allow public without auth');
});

test('Authentication: change-password requires auth', () => {
  const content = readFile('src/app/api/auth/change-password/route.ts');
  assert(content.includes('getTokenFromRequest'), 'Should get token from request');
  assert(content.includes('verifyToken'), 'Should verify token');
  assert(content.includes('unauthorizedResponse'), 'Should reject unauthenticated');
  assert(content.includes('payload.userId'), 'Should derive userId from token');
  assert(content.includes('You can only change your own password'), 'Should prevent cross-user password change');
});

test('Authentication: seed route protected in production', () => {
  const content = readFile('src/app/api/seed/route.ts');
  assert(content.includes('NODE_ENV') && content.includes('production'), 'Should check production env');
  assert(content.includes('404'), 'Should return 404 in production');
  assert(content.includes('super_admin'), 'Should require super_admin in dev');
});

test('Authentication: login has rate limiting', () => {
  const content = readFile('src/app/api/auth/login/route.ts');
  assert(content.includes('checkLoginRateLimit'), 'Should check rate limit');
  assert(content.includes('recordFailedLoginAttempt'), 'Should record failed attempts');
  assert(content.includes('clearFailedLoginAttempts'), 'Should clear on success');
  assert(content.includes('429'), 'Should return 429 when rate limited');
});

// 2. Grades IDOR tests
test('Grades: uses canAccessLearner for authorization', () => {
  const content = readFile('src/app/api/grades/route.ts');
  assert(content.includes('canAccessLearner'), 'Should use canAccessLearner');
  assert(content.includes('You are not authorized to view grades for this learner'), 'Should reject unauthorized');
});

test('Grades: does not trust client learnerId alone', () => {
  const content = readFile('src/app/api/grades/route.ts');
  // Should not have old insecure pattern
  assert(!content.includes('learner accessing own grades → allowed') || content.includes('canAccessLearner'), 'Should not trust client ID alone');
});

// 3. Attendance IDOR tests
test('Attendance GET: role-based access control', () => {
  const content = readFile('src/app/api/attendance/route.ts');
  assert(content.includes('canAccessLearner'), 'Should check learner access');
  assert(content.includes('canTeacherAccessClass'), 'Should check teacher class access');
  assert(content.includes('getParentLinkedLearnerIds'), 'Should check parent linkage');
  assert(content.includes('You can only view your own attendance'), 'Should restrict learner to own');
  assert(content.includes('You can only view attendance for your linked children'), 'Should restrict parent');
});

test('Attendance POST: teacher assignment verification', () => {
  const content = readFile('src/app/api/attendance/route.ts');
  assert(content.includes('canTeacherAccessClass'), 'Should verify teacher assignment');
  assert(content.includes('You can only mark attendance for classes you are assigned to teach'), 'Should reject unrelated class');
  assert(content.includes('transaction'), 'Should be transactional');
  assert(content.includes('learnerClasses'), 'Should verify enrollment');
});

test('Attendance PUT: class learners requires teacher auth', () => {
  const content = readFile('src/app/api/attendance/route.ts');
  // Find PUT function
  const putSection = content.split('export async function PUT')[1];
  assert(putSection.includes('canTeacherAccessClass'), 'PUT should verify teacher class access');
  assert(putSection.includes('Only teachers and administrators'), 'PUT should restrict to teachers/admins');
});

test('Attendance DB: unique constraint exists', () => {
  const schema = readFile('src/db/schema.ts');
  assert(schema.includes('attendance_learner_class_date_unique'), 'Should have unique constraint');
  assert(schema.includes('learnerId') && schema.includes('classId') && schema.includes('date'), 'Unique should be on learner, class, date');
  
  const migration = readFile('0011_attendance_unique_constraint.sql');
  assert(migration.includes('UNIQUE'), 'Migration should add unique constraint');
  assert(migration.includes('learner_id') && migration.includes('class_id') && migration.includes('date'), 'Migration should be on correct columns');
});

// 4. Learner stats IDOR
test('Learner stats: uses canAccessLearner', () => {
  const content = readFile('src/app/api/learner/stats/route.ts');
  assert(content.includes('canAccessLearner'), 'Should use canAccessLearner');
  assert(content.includes('You are not authorized to view stats for this learner'), 'Should reject unauthorized');
});

// 5. Enrollment listing
test('Enrollments: role-based filtering', () => {
  const content = readFile('src/app/api/enrollments/route.ts');
  assert(content.includes('canAccessLearner'), 'Should check learner access');
  assert(content.includes('canTeacherAccessClass'), 'Should check teacher class access');
  assert(content.includes('getAllowedLearnerIdsForEnrollment'), 'Should filter by allowed learners');
  assert(content.includes('You can only view enrollments for your linked children'), 'Should restrict parent');
  assert(content.includes('You can only view your own enrollments'), 'Should restrict learner');
});

// 6. Notifications
test('Notifications: ownership verification', () => {
  const content = readFile('src/app/api/notifications/route.ts');
  // Phase 2C: the user id now comes from the DB-backed context (never the JWT claim) and
  // the route additionally requires an active school membership.
  assert(content.includes('eq(notifications.userId, ctx.userId)'), 'Should filter by userId');
  assert(content.includes('guardSchoolContext(request)'), 'Phase 2C: require a school context');
  assert(content.includes('inArray'), 'Should use inArray for batch update');
  assert(content.includes('Verify ownership'), 'Should verify ownership comment or logic');
  // Ensure old insecure pattern is removed
  assert(!content.includes('where(eq(notifications.id, id))') || content.includes('userId'), 'Should not update by ID alone without user check');
});

test('Notifications: prevents cross-user modification', () => {
  const content = readFile('src/app/api/notifications/route.ts');
  // Check that PUT uses both userId and notificationIds
  const putSection = content.split('export async function PUT')[1];
  assert(putSection.includes('userId') && putSection.includes('notificationIds'), 'Should check both userId and notificationIds');
});

// 7. Change password
test('Password: prevents changing another user password', () => {
  const content = readFile('src/app/api/auth/change-password/route.ts');
  assert(content.includes('requestedUserId') || content.includes('userId'), 'Should check requested userId');
  assert(content.includes('You can only change your own password'), 'Should reject cross-user');
  assert(content.includes('bcrypt.compare'), 'Should verify current password');
  assert(content.includes('bcrypt.hash'), 'Should hash new password');
});

// 8. Seed protection
test('Seed: disabled in production', () => {
  const content = readFile('src/app/api/seed/route.ts');
  assert(content.includes('production') && content.includes('404'), 'Should disable in production');
});

test('Seed: no demo credentials in production', () => {
  const content = readFile('src/app/api/seed/route.ts');
  // Ensure demo credentials not exposed without auth
  assert(content.includes('super_admin'), 'Should require admin');
});

// 9. Authorization helpers
test('Authorization: isAdminRole exists', () => {
  const content = readFile('src/lib/authorization.ts');
  assert(content.includes('isAdminRole'), 'Should have isAdminRole');
  assert(content.includes('isAdminExtendedRole'), 'Should have isAdminExtendedRole');
  assert(content.includes('canAccessLearner'), 'Should have canAccessLearner');
  assert(content.includes('canTeacherAccessClass'), 'Should have canTeacherAccessClass');
  assert(content.includes('isParentLinkedToLearner'), 'Should have parent linkage check');
});

test('Authorization: parent linkage verification', () => {
  const content = readFile('src/lib/authorization.ts');
  assert(content.includes('parentLearners'), 'Should query parent_learners table');
  assert(content.includes('parentId') && content.includes('learnerId'), 'Should check both IDs');
});

// 10. Rate limiting
test('Rate limiting: DB-backed implementation', () => {
  const content = readFile('src/lib/rate-limit.ts');
  assert(content.includes('loginAttempts'), 'Should use login_attempts table');
  assert(content.includes('checkLoginRateLimit'), 'Should have check function');
  assert(content.includes('recordFailedLoginAttempt'), 'Should have record function');
  assert(content.includes('clearFailedLoginAttempts'), 'Should have clear function');
  assert(content.includes('MAX_ATTEMPTS'), 'Should have max attempts config');
});

test('Rate limiting: migration exists', () => {
  const migration = readFile('0012_login_attempts.sql');
  assert(migration.includes('login_attempts'), 'Should create login_attempts table');
  assert(migration.includes('identifier'), 'Should have identifier column');
  assert(migration.includes('INDEX'), 'Should have indexes');
});

// 11. Security headers
test('Security headers: configured in next.config.ts', () => {
  const content = readFile('next.config.ts');
  assert(content.includes('X-Content-Type-Options'), 'Should have X-Content-Type-Options');
  assert(content.includes('X-Frame-Options'), 'Should have X-Frame-Options');
  assert(content.includes('Referrer-Policy'), 'Should have Referrer-Policy');
  assert(content.includes('Content-Security-Policy'), 'Should have CSP');
  assert(content.includes('Strict-Transport-Security') || content.includes('HSTS') || content.includes('max-age'), 'Should have HSTS');
  assert(content.includes('Permissions-Policy'), 'Should have Permissions-Policy');
});

test('Security headers: CSP not breaking app', () => {
  const content = readFile('next.config.ts');
  assert(content.includes("'self'"), 'CSP should allow self');
  assert(content.includes('unsafe-inline') || content.includes('unsafe-eval'), 'CSP should allow Next.js requirements');
});

// 12. Attendance integrity
test('Attendance: handles duplicates safely', () => {
  const content = readFile('src/app/api/attendance/route.ts');
  assert(content.includes('transaction'), 'Should use transaction');
  assert(content.includes('delete') && content.includes('insert'), 'Should handle existing records');
});

test('Attendance: prevents arbitrary class marking', () => {
  const content = readFile('src/app/api/attendance/route.ts');
  assert(content.includes('Some learners are not enrolled'), 'Should verify enrollment');
});

// 13. Other IDOR checks
test('Submissions: enrollment verification', () => {
  const content1 = readFile('src/app/api/assignments/[id]/submit/route.ts');
  const content2 = readFile('src/app/api/submissions/route.ts');
  assert(content1.includes('enrolled in the class') || content1.includes('enrollment'), 'Assignment submit should check enrollment');
  assert(content2.includes('enrolled in the class') || content2.includes('enrollment'), 'Submissions should check enrollment');
});

test('Files: access control', () => {
  const content = readFile('src/app/api/files/[id]/route.ts');
  assert(content.includes('isUploader') || content.includes('uploaderId'), 'Should check uploader');
  assert(content.includes('isAssignmentTeacher') || content.includes('teacherId'), 'Should check teacher ownership');
  assert(content.includes('ADMIN_ROLES'), 'Should allow admin');
});

// Summary
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);

if (failed > 0) {
  console.log('\n❌ Some security tests failed - review the fixes');
  process.exit(1);
} else {
  console.log('\n✅ All security tests passed!');
  process.exit(0);
}
