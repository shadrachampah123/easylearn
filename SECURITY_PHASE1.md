# Phase 1 Security Hardening - Summary (Updated after Review)

## Date: 2026-09-11 (Review Update: 2026-09-11)
## Branch: arena/01a0922a-easylearn
## PR: #16 - security: harden authorization and critical API access

---

## 1. Vulnerabilities Fixed

### 1.1 User Directory Enumeration (GET /api/users)
- **Before**: Any authenticated user could list all users with emails and phone numbers
- **After**: Only `super_admin`, `school_admin`, `head_teacher` can list users
- **Fix**: Added role check at start of GET handler

### 1.2 Grade IDOR (GET /api/grades?learnerId=...)
- **Before**: Parents could view any learner's grades; only learner own and teacher scope were checked
- **After**: Uses centralized `canAccessLearner()` which verifies:
  - Learner: own only
  - Parent: linked via `parent_learners` table
  - Teacher: **STRICTLY** learners enrolled in classes teacher teaches via `teacher_classes` + `classTeacherId` + `learnerClasses` (NOT via historical assignment/quiz activity)
  - Admin (super_admin, school_admin, head_teacher): all
- **Fix**: Rewrote authorization to use `canAccessLearner` helper with strict class-based check. Removed assignment/quiz activity privilege that could grant access to unrelated learners.
- **Regression test**: `tests/real-authorization.test.ts` proves teacher cannot obtain access merely through unrelated assignment activity

### 1.3 Attendance IDOR
#### GET /api/attendance
- **Before**: Only learner own was enforced; parents and teachers could view any
- **After**:
  - Learner: own only
  - Parent: linked children only (via `getParentLinkedLearnerIds`)
  - Teacher: only classes they teach (via `canTeacherAccessClass` and `getTeacherAccessibleClassIds`) - **STRICT, no assignment/quiz fallback**
  - super_admin, school_admin, head_teacher: school-wide (intentional per role model)
- **Fix**: Full role-based filtering with ownership checks

#### POST /api/attendance
- **Before**: Any teacher could mark attendance for any class, no enrollment verification, destructive delete-then-insert without transaction
- **After**:
  - Teacher (`teacher` role only): must be assigned to class (`canTeacherAccessClass`), validates enrollment
  - head_teacher, super_admin, school_admin: school-wide access **INTENTIONAL** per existing role model (see 1.3.1)
  - Transactional delete+insert to ensure atomicity
  - Handles duplicate safely (unique constraint prevents race)
- **Fix**: Added assignment verification, enrollment check, transaction, explicit documentation

##### 1.3.1 head_teacher Attendance Authorization (Review Item #3)
- **Question**: Does head_teacher marking any class intentionally?
- **Analysis**: Existing role model shows head_teacher is in ADMIN_ROLES for many routes:
  - `activity-logs`, `parent-learners`, `timetable`, `users`, `dashboard/admin`, `report-access` ADMIN_REPORT_ROLES includes head_teacher
  - For reporting, head_teacher can report on every learner (school-wide)
  - For attendance, original code allowed head_teacher + super_admin + school_admin + teacher, but only checked class assignment for `teacher` role, not head_teacher
- **Conclusion**: **INTENTIONAL** - head_teacher is considered school administrator with school-wide attendance administration per existing EasyLearn role model. We explicitly document this in code comments and tests, rather than silently changing role model.
- **Documentation**: Added comment block in `src/app/api/attendance/route.ts` explaining intentional school-wide access for head_teacher
- **Test**: `tests/real-authorization.test.ts` includes test "head_teacher has school-wide attendance access (intentional)" that verifies head_teacher is admin_extended while teacher is not

#### PUT /api/attendance (get class learners)
- **Before**: Any authenticated user could get learners for any classId
- **After**: Only teachers/admins, and teachers must be assigned to class, head_teacher/admins school-wide
- **Fix**: Added role check and `canTeacherAccessClass` for teacher role only

### 1.4 Learner Stats IDOR (GET /api/learner/stats)
- **Before**: Only learner own was checked
- **After**: Uses `canAccessLearner` for parent, teacher (strict class-based), admin checks
- **Fix**: Centralized authorization

### 1.5 Enrollment Listing (GET /api/enrollments)
- **Before**: Returned every enrollment to every authenticated user
- **After**:
  - Admin (including head_teacher): all
  - Teacher: only learners enrolled in teacher's classes (strict, not assignment/quiz activity)
  - Parent: linked children only
  - Learner: own only
- **Fix**: Role-based filtering with `getAllowedLearnerIdsForEnrollment` using strict teacher check

### 1.6 Notification IDOR (PUT /api/notifications)
- **Before**: `notificationIds` loop updated by ID without ownership check, allowing cross-user modification
- **After**: Update query includes `eq(notifications.userId, payload.userId)` and `inArray(ids)`, so only own notifications can be marked read
- **Fix**: Ownership verification server-side

### 1.7 Announcements Authentication (GET /api/announcements)
- **Before**: Accessible without authentication, returning all announcements including non-public
- **After**:
  - `?public=true`: no auth, returns only `isPublic=true`
  - Otherwise: requires auth, returns all
- **Fix**: Split public vs authenticated paths

### 1.8 Change Password (POST /api/auth/change-password)
- **Before**: Unauthenticated, accepts arbitrary `userId`, no auth, allows changing anyone's password
- **After**:
  - Requires authentication (`getTokenFromRequest` + `verifyToken`)
  - Derives userId from JWT (`payload.userId`), rejects if client supplies different ID
  - Verifies current password via `bcrypt.compare`
  - Hashes new password securely
  - Admin reset remains via separate `/api/users/[id]/PATCH` which is admin-only
- **Fix**: Full rewrite with auth and ownership checks

### 1.9 Seed Protection (POST /api/seed)
- **Before**: Unauthenticated, allows reseeding production with known demo credentials
- **After**:
  - Production (`NODE_ENV=production`): returns 404, disabled entirely
  - Development: requires `super_admin` auth
- **Fix**: Environment check + role check

### 1.10 Authentication Security
- **Before**: Some routes missing auth (announcements, change-password, seed), JWT validation exists but not consistently enforced
- **After**: All protected routes now consistently require auth, JWT validated server-side via `verifyToken`, expired/invalid rejected, role from verified token not client-controlled
- **Fix**: Audited all routes, ensured `getTokenFromRequest` + `verifyToken` pattern

### 1.11 Login Rate Limiting
- **Before**: Unlimited password guessing
- **After**: DB-backed rate limiting (`login_attempts` table) that works across Vercel instances:
  - Max 5 failed attempts per identifier in 15-minute window
  - Block for 30 minutes after exceeding
  - Records IP and identifier, clears on success, cleans old entries
  - Returns 429 when blocked
- **Fix**: Created `login_attempts` table + `src/lib/rate-limit.ts` + integration in login route

### 1.12 Security Headers
- **Before**: No security headers
- **After**: Added in `next.config.ts`:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `X-XSS-Protection: 1; mode=block`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()`
  - `Content-Security-Policy` (permissive but protective)
  - `Strict-Transport-Security` in production
  - `X-DNS-Prefetch-Control`
  - `Cache-Control: no-store` for API routes
- **Fix**: Updated `next.config.ts`

### 1.13 Attendance DB Integrity (Review Item #4 - SAFER MIGRATION)
- **Before**: No unique constraint for `(learner, class, date)`, allowing duplicates
- **After**:
  - Added unique constraint `attendance_learner_class_date_unique` on `(learner_id, class_id, date)`
  - Migration `0011_attendance_unique_constraint.sql` now uses SAFER strategy:
    1. Creates backup table `attendance_duplicates_backup` to preserve ALL duplicates before deletion
    2. Backs up duplicates that would be deleted (with ON CONFLICT DO NOTHING for idempotency)
    3. Logs duplicate count via RAISE NOTICE for audit
    4. Deletes duplicates keeping most recent (ORDER BY created_at DESC, id DESC) - retains latest correction
    5. Adds unique constraint via DO block checking existence (idempotent)
    6. Adds indexes
  - **Safety**: No legitimate data lost - all deleted duplicates archived in backup table with deleted_at and reason
  - **Retention logic**: Keeps latest created_at, which is likely most up-to-date correction if teacher corrected attendance
  - Updated `src/db/schema.ts` to reflect constraint
  - Write operation now transactional and handles duplicates safely
- **Fix**: Safer migration + schema update + transactional write
- **Verification**: Migration does NOT execute against production during review, only inspected

### 1.14 Other Critical IDOR Checks
- **Assignments submit**: Added enrollment verification - learner must be enrolled in assignment's class (if enrollment records exist)
- **Submissions**: Same enrollment check
- **Files**: Already had proper access control (uploader or assignment teacher or admin) - verified secure
- **Messages**: Already scoped to user's conversations - verified
- **Parent-learners**: Already admin-only for write, parent/learner own for read - verified

### 1.15 Teacher Access Strictness (Review Item #2)
- **Before (Phase 1 initial)**: `canAccessLearner` used `getAccessibleLearnerIds` which included assignment/quiz activity as granting access
- **Risk**: Teacher who previously interacted with assignment/quiz could access learner not in their currently assigned classes
- **After (Review fix)**: Teacher access based SOLELY on current teaching relationship:
  - `teacher_classes` assignment OR `classes.classTeacherId` (homeroom) AND `learnerClasses` enrollment
  - Removed `submissions` and `quizAttempts` from granting access
  - Uses `getTeacherAccessibleLearnerIds()` which only checks class enrollment
  - Pure functions `canTeacherAccessLearnerPure` and `canAccessLearnerPure` added for testability
- **Regression test**: `tests/real-authorization.test.ts` includes "teacher cannot gain access via assignment activity alone" that proves teacher-unrelated who had assignment activity with learner-1 but teaches class-99 cannot access learner-1 (enrolled in class-1)

---

## 2. API Routes Changed

- `src/app/api/users/route.ts` - restricted to admin extended roles
- `src/app/api/grades/route.ts` - fixed parent IDOR, centralized auth, strict teacher check
- `src/app/api/attendance/route.ts` - full rewrite for GET/POST/PUT with role checks, transaction, enrollment verification, explicit head_teacher documentation
- `src/app/api/learner/stats/route.ts` - fixed parent/teacher IDOR
- `src/app/api/enrollments/route.ts` - role-based filtering, strict teacher check
- `src/app/api/notifications/route.ts` - ownership verification
- `src/app/api/announcements/route.ts` - auth for non-public
- `src/app/api/auth/change-password/route.ts` - full secure rewrite
- `src/app/api/seed/route.ts` - production disabled, dev requires super_admin
- `src/app/api/auth/login/route.ts` - added rate limiting
- `src/app/api/assignments/[id]/submit/route.ts` - enrollment check
- `src/app/api/submissions/route.ts` - enrollment check
- `next.config.ts` - security headers
- `src/db/schema.ts` - unique constraint + login_attempts table
- `src/lib/authorization.ts` - NEW centralized auth helpers, now STRICT (class-based only for teachers), pure functions for testing
- `src/lib/rate-limit.ts` - NEW DB-backed rate limiting
- `src/lib/report-access.ts` - Kept for reporting, but NOT used for authorization (separation of concerns)

---

## 3. Database Migrations Created

- `0011_attendance_unique_constraint.sql` (and `drizzle/0011...`) - SAFER VERSION:
  - Creates backup table `attendance_duplicates_backup` to preserve duplicates
  - Backs up duplicates before deletion (ON CONFLICT DO NOTHING)
  - Logs duplicate count via RAISE NOTICE
  - Deletes duplicates keeping latest (created_at DESC, id DESC)
  - Adds unique constraint via idempotent DO block
  - Adds indexes including backup table index
  - **Safe on production**: No data loss, all deleted rows archived, idempotent

- `0012_login_attempts.sql` (and `drizzle/0012...`)
  - Creates `login_attempts` table with `id`, `identifier`, `ip_address`, `created_at`
  - Indexes on identifier, created_at, and composite

- Updated `run-migration.js` to include new migrations

---

## 4. Automated Tests Added (Review Item #1 - Real Authorization Tests)

### 4.1 Static Security Tests (28 tests)
- `tests/security.test.js` - checks source code contains required security patterns:
  - Authentication, grades, attendance, enrollments, notifications, password, seed, authorization helpers, rate limiting, security headers, etc.
  - Ensures fixes are present

### 4.2 Real Executable Authorization Tests (15 tests) - NEW per review
- `tests/real-authorization.test.ts` - exercises actual authorization logic without external services:
  - **learner cannot access another learner's grades** - pure function test
  - **parent cannot access unrelated learner's grades** - pure function with parentLinks map
  - **parent can access linked child's grades** - verifies linked access
  - **teacher cannot access unrelated learner** - strict class-based check
  - **teacher cannot gain access via assignment activity alone (regression)** - proves fix for #2, teacher-unrelated with assignment activity for learner-1 but teaches class-99 cannot access learner-1
  - **learner cannot access another learner's attendance** - same logic
  - **parent cannot access unrelated attendance** - parent linkage
  - **teacher cannot mark attendance for unrelated class** - class assignment check
  - **notification ownership enforced** - simulates in-memory notifications, verifies only own can be updated
  - **change-password cannot target another user** - checks cross-user rejection
  - **unauthenticated protected requests rejected** - tests getTokenFromRequest returns null
  - **admin retains functionality** - super_admin, school_admin, head_teacher can access any
  - **head_teacher school-wide attendance (intentional)** - documents intentional behavior per role model
  - **ordinary users cannot escalate** - isAdminRole checks
  - **attendance duplicate prevention** - unique key logic

- **Total**: 43 tests (28 static + 15 real), all PASS
- **No external services required**: Uses in-memory Maps, pure functions, mocked requests
- **Run via**: `DATABASE_URL=dummy JWT_SECRET=... npm test` or `npx tsx tests/real-authorization.test.ts`

- Added `npm test`, `test:security`, `test:real`, `test:all` scripts

---

## 5. Findings Intentionally Left for Later Phase

### LocalStorage JWT
- **Current**: JWT stored in localStorage (`el_token`) and also httpOnly cookie
- **Risk**: XSS could steal token from localStorage
- **Why left**: Large auth redesign required, out of scope for Phase 1
- **Mitigation now**: CSP, server-side validation, httpOnly cookie with secure/sameSite

### Multi-tenancy / school_id
- Explicitly out of scope per instructions

### Assignment/Submission Enrollment Check
- Currently only enforces if learner has any enrollment records (backward compat for legacy data without enrollments)
- Can be tightened to always require enrollment in Phase 2

### File Uploads
- No virus scanning, only extension/MIME checks - out of scope

---

## 6. Remaining Known Security Risks

1. **LocalStorage JWT**: Vulnerable to XSS, should move to httpOnly-only with CSRF in Phase 2
2. **No CSRF**: SameSite=lax, reasonable but should add CSRF token if cookie-only
3. **No 2FA**: Should be considered for admin accounts
4. **Password Complexity**: Only length checks
5. **Audit Logs**: Not for all sensitive actions
6. **File Uploads**: No virus scanning
7. **Rate Limiting**: Only login is rate limited, other endpoints could benefit
8. **CORS**: No explicit config, default same-origin
9. **Demo Credentials**: Hardcoded in seed but route disabled in prod
10. **No IP Allowlisting**: For super_admin

---

## 7. Verification (After Review)

- **Typecheck**: `tsc --noEmit` - PASS (0 errors)
- **Build**: `DATABASE_URL=dummy JWT_SECRET=... next build` - PASS (95 routes)
- **Tests**: 
  - `node tests/security.test.js` - 28/28 PASS
  - `npx tsx tests/real-authorization.test.ts` - 15/15 PASS
  - `npm test` (both) - 43/43 PASS
- **App Start**: Build succeeds

---

## 8. Role Matrix (Verified After Review)

- `super_admin`: Full access, can seed (dev only), manage users, view all, mark any attendance
- `school_admin`: Same as super_admin except cannot delete users and cannot seed
- `head_teacher`: **INTENTIONALLY** considered admin extended per existing role model (ADMIN_ROLES includes head_teacher in activity-logs, parent-learners, timetable, users, dashboard/admin, report-access). For attendance, head_teacher has school-wide administration (can mark/view any class). This is documented and tested, not silently changed. For grades/stats/enrollments, head_teacher has school-wide access (all learners).
- `teacher`: **STRICT** - Can only view grades/attendance/stats for learners enrolled in classes they teach via teacher_classes or homeroom (NOT via assignment/quiz activity). Can only mark attendance for assigned classes. Can only view enrollments for their classes. Regression test proves cannot gain access via assignment activity alone.
- `parent`: Can only view grades/attendance/stats/enrollments for linked children via parent_learners
- `learner`: Can only view own, can submit for enrolled classes

Least-privileged secure behavior chosen where inconsistent, with explicit documentation for head_teacher.

---

## 9. Production Safety

- No production data deleted (migration now backs up duplicates)
- Migrations idempotent (IF NOT EXISTS, ON CONFLICT DO NOTHING, DO blocks)
- No .env committed
- No credentials exposed
- Seed disabled in production
- No destructive DB commands executed during review (migration only inspected, not run against prod)
- Backup table `attendance_duplicates_backup` preserves any deleted duplicates for audit

---

## 10. How to Apply Migrations

```bash
export DATABASE_URL="your-neon-url"
node run-migration.js
# Or specific
node run-migration.js 0011_attendance_unique_constraint.sql
node run-migration.js 0012_login_attempts.sql
```

---

## 11. Review Items Addressed

1. **Real authorization tests**: Added `tests/real-authorization.test.ts` with 15 executable tests covering all required scenarios, no external services, pure functions + in-memory mocks, plus regression test for assignment activity privilege removal
2. **canAccessLearner() strictness**: Removed assignment/quiz activity from granting teacher access, now only class teaching relationship, added pure functions for testability, added regression test
3. **head_teacher attendance**: Confirmed intentional per existing role model (ADMIN_ROLES), explicitly documented in code and SECURITY_PHASE1.md, added test proving intentional school-wide access
4. **Migration 0011 safety**: Modified to backup duplicates to `attendance_duplicates_backup` before deletion, logs counts, idempotent, safe on production, explained retention logic (keeps latest)

---

## 12. Next Steps (Phase 2+)

- Replace localStorage JWT with httpOnly + CSRF
- Add 2FA, password complexity, rate limiting on other endpoints
- Implement multi-tenancy (out of scope for Phase 1)
- Virus scanning for uploads
- Enhance audit logging
- Rotate demo credentials
- IP allowlisting for super_admin

---

## 13. Merge Safety Assessment

**Is PR #16 now safe to merge? YES**, with following conditions:

- Migrations should be applied in staging first, verify backup table and duplicate handling
- No breaking changes to legitimate functionality (admin retains access, teacher restricted to assigned classes per security requirements, parent/learner restricted to own/linked)
- All 43 tests pass, typecheck and build pass
- Security headers added but permissive enough to not break app (allows unsafe-inline/eval for Next.js)
- Rate limiting is DB-backed, works across Vercel instances
- Seed disabled in production
- Change-password now secure
- Notification ownership enforced
- Attendance unique constraint prevents duplicates with backup safety

**Remaining risks** are documented and acceptable for Phase 1 (localStorage JWT, no 2FA, etc.) and planned for Phase 2.

**DO NOT MERGE AUTOMATICALLY** - requires human review, but from security perspective, PR is ready.
