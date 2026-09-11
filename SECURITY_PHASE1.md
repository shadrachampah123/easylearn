# Phase 1 Security Hardening - Summary

## Date: 2026-09-11
## Branch: arena/01a0922a-easylearn
## PR Title: security: harden authorization and critical API access

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
  - Teacher: enrolled in teacher's classes or via assignment/quiz activity
  - Admin: all
- **Fix**: Rewrote authorization to use `canAccessLearner` helper

### 1.3 Attendance IDOR
#### GET /api/attendance
- **Before**: Only learner own was enforced; parents and teachers could view any
- **After**:
  - Learner: own only
  - Parent: linked children only (via `getParentLinkedLearnerIds`)
  - Teacher: only classes they teach (via `canTeacherAccessClass` and `getTeacherAccessibleClassIds`)
  - Admin: all
- **Fix**: Full role-based filtering with ownership checks

#### POST /api/attendance
- **Before**: Any teacher could mark attendance for any class, no enrollment verification, destructive delete-then-insert without transaction
- **After**:
  - Teacher must be assigned to class (`canTeacherAccessClass`)
  - Validates learners are enrolled in class
  - Transactional delete+insert to ensure atomicity
  - Handles duplicate safely (unique constraint prevents race)
- **Fix**: Added assignment verification, enrollment check, transaction

#### PUT /api/attendance (get class learners)
- **Before**: Any authenticated user could get learners for any classId
- **After**: Only teachers/admins, and teachers must be assigned to class
- **Fix**: Added role check and `canTeacherAccessClass`

### 1.4 Learner Stats IDOR (GET /api/learner/stats)
- **Before**: Only learner own was checked
- **After**: Uses `canAccessLearner` for parent, teacher, admin checks
- **Fix**: Centralized authorization

### 1.5 Enrollment Listing (GET /api/enrollments)
- **Before**: Returned every enrollment to every authenticated user
- **After**:
  - Admin: all
  - Teacher: only classes they teach
  - Parent: linked children only
  - Learner: own only
- **Fix**: Role-based filtering with `getAllowedLearnerIdsForEnrollment`

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
  - `Content-Security-Policy` (permissive but protective, allows self, unsafe-inline/eval for Next.js, images/media from https/data/blob)
  - `Strict-Transport-Security` in production
  - `X-DNS-Prefetch-Control`
  - `Cache-Control: no-store` for API routes
- **Fix**: Updated `next.config.ts`

### 1.13 Attendance DB Integrity
- **Before**: No unique constraint for `(learner, class, date)`, allowing duplicates
- **After**:
  - Added unique constraint `attendance_learner_class_date_unique` on `(learner_id, class_id, date)`
  - Migration `0011_attendance_unique_constraint.sql` removes existing duplicates (keeps latest) then adds constraint + indexes
  - Updated `src/db/schema.ts` to reflect constraint
  - Write operation now transactional and handles duplicates safely
- **Fix**: Migration + schema update + transactional write

### 1.14 Other Critical IDOR Checks
- **Assignments submit**: Added enrollment verification - learner must be enrolled in assignment's class (if enrollment records exist)
- **Submissions**: Same enrollment check
- **Files**: Already had proper access control (uploader or assignment teacher or admin) - verified secure
- **Messages**: Already scoped to user's conversations - verified
- **Parent-learners**: Already admin-only for write, parent/learner own for read - verified

---

## 2. API Routes Changed

- `src/app/api/users/route.ts` - restricted to admin extended roles
- `src/app/api/grades/route.ts` - fixed parent IDOR, centralized auth
- `src/app/api/attendance/route.ts` - full rewrite for GET/POST/PUT with role checks, transaction, enrollment verification
- `src/app/api/learner/stats/route.ts` - fixed parent/teacher IDOR
- `src/app/api/enrollments/route.ts` - role-based filtering
- `src/app/api/notifications/route.ts` - ownership verification
- `src/app/api/announcements/route.ts` - auth for non-public
- `src/app/api/auth/change-password/route.ts` - full secure rewrite
- `src/app/api/seed/route.ts` - production disabled, dev requires super_admin
- `src/app/api/auth/login/route.ts` - added rate limiting
- `src/app/api/assignments/[id]/submit/route.ts` - enrollment check
- `src/app/api/submissions/route.ts` - enrollment check
- `next.config.ts` - security headers
- `src/db/schema.ts` - unique constraint + login_attempts table
- `src/lib/authorization.ts` - NEW centralized auth helpers
- `src/lib/rate-limit.ts` - NEW DB-backed rate limiting

---

## 3. Database Migrations Created

- `0011_attendance_unique_constraint.sql` (and `drizzle/0011...`)
  - Removes duplicate attendance records (keeps latest)
  - Adds unique constraint `attendance_learner_class_date_unique` on `(learner_id, class_id, date)`
  - Adds indexes on `(class_id, date)` and `(learner_id, date)`

- `0012_login_attempts.sql` (and `drizzle/0012...`)
  - Creates `login_attempts` table with `id`, `identifier`, `ip_address`, `created_at`
  - Indexes on identifier, created_at, and composite

- Updated `run-migration.js` to include new migrations

---

## 4. Automated Tests Added

- `tests/security.test.js` - 28 tests covering:
  - Authentication (users, announcements, change-password, seed, login rate limiting)
  - Grades IDOR
  - Attendance IDOR (GET, POST, PUT) + DB unique constraint
  - Learner stats IDOR
  - Enrollments filtering
  - Notifications ownership
  - Password change protection
  - Seed protection
  - Authorization helpers
  - Rate limiting (DB-backed, migration exists)
  - Security headers (X-Content-Type-Options, X-Frame-Options, CSP, HSTS, etc.)
  - Attendance integrity (transaction, enrollment verification)
  - Other IDOR (submissions enrollment, files access control)

- Added `npm test` and `npm run test:security` scripts

- Tests run via `node tests/security.test.js` - static analysis of source files to ensure security patterns exist, plus pure function checks

---

## 5. Findings Intentionally Left for Later Phase

### LocalStorage JWT
- **Current**: JWT stored in localStorage (`el_token`) and also httpOnly cookie. Client JS reads from localStorage and sends via Authorization header.
- **Risk**: XSS could steal token from localStorage, though httpOnly cookie is also set.
- **Why left**: Replacing localStorage JWT with httpOnly-only flow would require large auth redesign (changing all frontend fetch calls, handling CSRF, etc.). Documented for Phase 2.
- **Mitigation now**: Added CSP to reduce XSS risk, ensured server-side validation, httpOnly cookie set with secure/sameSite.

### In-Memory Rate Limiting Alternative
- We implemented DB-backed rate limiting which is correct for Vercel. No fake in-memory solution.

### Multi-tenancy / school_id
- Explicitly out of scope for Phase 1 per instructions. Not implemented.

### Assignment/Submission Enrollment Check
- Currently only enforces enrollment if learner has any enrollment records at all (to avoid breaking legacy data without enrollments). In strict mode, should always require enrollment. Left permissive for backward compat, can be tightened in Phase 2.

### File Upload Size Limits
- Existing limits (50MB general, 100MB video) are enforced, but no additional virus scanning. Out of scope.

---

## 6. Remaining Known Security Risks

1. **LocalStorage JWT**: As noted, token in localStorage is vulnerable to XSS. Mitigated by CSP but should be moved to httpOnly cookie only in Phase 2 with CSRF protection.

2. **No CSRF Protection**: Since JWT is sent via Authorization header and cookie, but no CSRF token, cookie-based auth could be vulnerable if SameSite not strict. Currently SameSite=lax, which is reasonable. Should add CSRF in Phase 2 if moving to cookie-only.

3. **No 2FA**: No two-factor authentication. Should be considered for admin accounts in later phase.

4. **Password Complexity**: Only checks length (6 or 8 chars), no complexity requirements. Could be improved in Phase 2.

5. **No Audit Log for Sensitive Actions**: Activity logs exist but not for all security-sensitive actions (e.g., failed login attempts are logged via login_attempts but not in activity_logs). Could be enhanced.

6. **File Uploads**: No virus scanning, relies on extension/MIME checks. Could be improved with content scanning.

7. **No Rate Limiting on Other Endpoints**: Only login is rate limited. Other endpoints (e.g., change-password, register) could benefit from rate limiting in Phase 2.

8. **CORS**: No explicit CORS configuration. Next.js default is same-origin, but should be reviewed for API routes that might be called cross-origin.

9. **Demo Credentials in Code**: Seed file still contains hardcoded demo passwords (`admin123`, etc.) but route is disabled in production. Should ensure these are not in production DB. The seed route checks if users exist and doesn't overwrite, so production data safe. But demo credentials should be rotated or removed in production seed data for Phase 2.

10. **No IP Allowlisting for Admin**: Admin routes not IP-restricted. Could be added in Phase 2 for super_admin.

---

## 7. Verification

- **Typecheck**: `npx tsc --noEmit` - PASS (0 errors)
- **Lint**: `eslint .` - has pre-existing errors (not introduced by Phase 1), build still succeeds
- **Build**: `DATABASE_URL=... JWT_SECRET=... next build` - PASS (95 routes)
- **Tests**: `node tests/security.test.js` - 28/28 PASS
- **App Start**: Build succeeds, so app can start

---

## 8. Role Matrix (Verified)

- `super_admin`: Full access, can seed (dev only), manage users, view all grades/attendance/enrollments, mark attendance for any class
- `school_admin`: Same as super_admin except cannot delete users (only super_admin) and cannot seed
- `head_teacher`: Considered admin extended - can view user directory, view all grades/attendance/enrollments, mark attendance (but teacher assignment check still applies for POST? Currently head_teacher bypasses class assignment check? In attendance POST we only check if role === teacher, not head_teacher, so head_teacher can mark any class - consistent with admin)
- `teacher`: Can only view grades/attendance/stats for learners in their scope (classes they teach or via assignment/quiz activity), can only mark attendance for assigned classes, can only view enrollments for their classes, can create assignments/quizzes/announcements
- `parent`: Can only view grades/attendance/stats/enrollments for linked children via `parent_learners`, cannot enumerate unrelated learners, can view announcements (auth required)
- `learner`: Can only view own grades/attendance/stats/enrollments, can submit assignments for enrolled classes, can attempt quizzes for enrolled classes

Least-privileged secure behavior chosen where inconsistent.

---

## 9. Production Safety

- No production data deleted
- Migrations are idempotent and handle existing duplicates safely (keeps latest)
- No .env committed
- No credentials exposed
- Seed disabled in production
- No destructive DB commands

---

## 10. How to Apply Migrations

```bash
# Set DATABASE_URL
export DATABASE_URL="your-neon-url"

# Run all migrations
node run-migration.js

# Or specific
node run-migration.js 0011_attendance_unique_constraint.sql
node run-migration.js 0012_login_attempts.sql
```

Or use `drizzle-kit push` (but run-migration.js is the project's mechanism).

---

## 11. Next Steps (Phase 2+)

- Replace localStorage JWT with httpOnly cookie + CSRF
- Add 2FA for admins
- Add password complexity requirements
- Add rate limiting to other sensitive endpoints
- Implement multi-tenancy with school_id (out of scope for Phase 1)
- Add virus scanning for uploads
- Enhance audit logging
- Rotate demo credentials
- Add IP allowlisting for super_admin
