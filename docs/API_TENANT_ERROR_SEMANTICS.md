# API tenant error semantics — 403 vs 404

**Status:** normative. **Applies to:** every route that calls `guardSchoolContext()` in
`src/lib/tenant.ts` (51 route files at the time of writing).

This document defines what EasyLearn's HTTP API returns when a request is refused, and
why. It exists because the integration of PR #30 and PR #31 changed the status code for
one class of denial (see §4) and reviewers need a single, explicit contract to check
against.

---

## 1. The two rules

EasyLearn uses exactly two refusals for "you may not have this", and they mean different
things.

### 403 Forbidden — a statement about *the caller*

> "I know who you are, and your own context or your own role does not permit this
> operation."

The 403 never reveals anything about a resource the caller could not already see. It is
raised **before** any tenant-scoped row is fetched, or **after** a row that the caller is
already entitled to see has been fetched.

### 404 Not Found — a statement about *the resource*

> "I am not going to tell you whether this resource exists."

The 404 is raised when the tenant-scoped query does not match a row. It is deliberately
indistinguishable across all of these cases:

| Case | Status | Body |
|---|---|---|
| The resource does not exist at all | 404 | `{"success": false, "error": "<Resource> not found"}` |
| The resource exists in **another tenant** | 404 | *identical* |
| The resource exists in the caller's tenant but query-level authorization hides it from the caller's role | 404 | *identical* |

**The anti-enumeration guarantee:** because the three cases above produce byte-identical
responses, a caller cannot use an endpoint to discover whether another tenant's data
exists. This is a security property, not a cosmetic choice, and it is covered by
regression tests (see §5).

---

## 2. Where each refusal is raised

### 403 — the caller's context or role

| Source | Condition | Message |
|---|---|---|
| `guardSchoolContext` | The account has **no active membership** in any school | `You do not have an active school membership in an active school` |
| `guardSchoolContext` | The account holds **more than one** active membership and has not selected one | `Select one of your schools before continuing` |
| `guardSchoolContext` | The selected school's lifecycle is **not `active`** (`provisioned` / `suspended` / `archived`) | `You do not have an active school membership in an active school` |
| `guardSchoolContext` | The token is **pre-v3** (no explicit selection was ever made) and the account is multi-school | `Select one of your schools before continuing` |
| `guardPlatformAdmin` | The route is platform-scoped and the caller is not `super_admin` | `Only platform administrators may perform this action` |
| Route role gate | The caller's school role cannot perform the verb at all | e.g. `Only teachers can create assignments`, `Only learners can submit assignments`, `You are not authorized to view submissions` |
| Route ownership check | The row **is** visible to the caller (same tenant) but the caller does not own it | e.g. `You can only edit your own assignments`, `You can only review submissions for your own assignments` |
| Route enrolment check | The learner is not enrolled in the class the assignment belongs to | `You are not enrolled in the class for this assignment` |

The ownership checks are the only 403s that are raised *after* a row is read. The row is
always read through a tenant-scoped query first, so a 403 in that position can only ever
concern a resource that already belongs to the caller's own tenant. It therefore discloses
nothing across a tenant boundary.

### 404 — the resource is invisible

Raised by `notFoundResponse("<Resource>")` whenever a tenant-scoped, authorization-aware
query returns no row. Concretely, the following all produce 404:

* an id that belongs to another school;
* an id that does not exist;
* an assignment that a learner may not see (not published, or the learner is not enrolled);
* an assignment that a teacher may not see (not their own, and they are not an
  administrator with oversight);
* a submission whose **own** row **or** whose **anchoring assignment** is outside the
  selected school;
* a question that does not belong to the assignment in the path;
* a parent's request for results for a learner they are **not** linked to.

---

## 3. Endpoint matrix for the routes changed by the PR #30 ⨯ PR #31 integration

| Endpoint | Cross-tenant | Same-tenant, wrong role | No school context |
|---|---|---|---|
| `GET /api/assignments` | 200 with an empty / own-school list (the query is scoped) | 200 with a filtered list | 403 |
| `POST /api/assignments` | 403 (`Only teachers can create assignments`) | 403 | 403 |
| `GET /api/assignments/[id]` | **404** | **404** (query-level authorization) | 403 |
| `PATCH /api/assignments/[id]` | **404** | **404** (teacher, colleague's); 403 (administrator, `You can only edit your own assignments`) | 403 |
| `DELETE /api/assignments/[id]` | **404** | **404** (teacher, colleague's); 403 (administrator) | 403 |
| `GET /api/assignments/[id]/questions` | **404** | **404** | 403 |
| `POST /api/assignments/[id]/questions` | **404** | **404** (not the owner); 403 (`Only teachers can add questions`) | 403 |
| `DELETE /api/assignments/[id]/questions` | **404** | **404** (not the owner); 403 (`Only teachers can delete questions`) | 403 |
| `GET /api/assignments/[id]/results` | **404** | **404** (learner/parent without a link) | 403 |
| `GET /api/assignments/[id]/corrections` | **404** | **404** | 403 |
| `POST /api/assignments/[id]/corrections` | **404** | **404** (not the owner); 403 (`Only teachers can post corrections`) | 403 |
| `POST /api/assignments/[id]/submit` | **404** | 403 (`You are not enrolled in the class for this assignment`) | 403 |
| `GET /api/submissions` | 200 with an empty / own-school list | 200 with a filtered list; 403 if the role may not view submissions | 403 |
| `POST /api/submissions` | **404** (`Assignment not found`) | 403 (`You are not enrolled in the class for this assignment`) | 403 |
| `GET /api/submissions/[id]` | **404** | **403** (`You can only review submissions for your own assignments`) | 403 |
| `PATCH /api/submissions/[id]/grade` | **404** | **403** (`You can only grade submissions for your own assignments`) | 403 |
| `POST /api/auth/select-school` | 403 (`Platform administrators do not select a school`) / 400 / 503 | 400 (`A schoolId is required`) | 403 / 400 |

---

## 4. The one behaviour change, and why it is the right one

Before the integration, PR #30's `GET /api/assignments/[id]/results` loaded the assignment
first and then refused a parent who asked for a `learnerId` that was not their own child
with **403**. PR #31 moved the parent rule *into* the authorization query
(`resolveAssignmentAccessPredicate`), so such a request no longer matches the assignment
row at all and the refusal becomes **404**.

The integrated implementation follows PR #31. The reasons:

1. **It discloses strictly less.** A 403 says "this exists but you may not have it"; a 404
   says nothing about existence. §1's anti-enumeration guarantee only holds if every
   invisible resource answers 404.
2. **PR #31's own suite already asserts 404** for exactly these cases ("parent cannot
   choose an unlinked learner" → 404, "parent cannot use an implicit child target" → 404),
   so the merged code matches the newer PR's contract rather than inventing a third one.
3. **The security property is unchanged.** The request is still refused and no foreign
   data is returned. `tests/tenant-authorization-db.test.ts` was updated to assert the 404
   *and* to assert that neither the foreign learner id nor the foreign submission id
   appears anywhere in the response body.

**Client impact:** a client that distinguishes 403 from 404 to render "you are not allowed"
versus "not found" will now show "not found" for a parent targeting the wrong learner. That
is a deliberate, reviewed trade-off; it is recorded as risk **R3** in
`docs/PR30_PR31_INTEGRATION_RESOLUTION.md`.

---

## 5. How this contract is enforced

`tests/tenant-integration-regression.test.ts` asserts the contract end to end against a
real PostgreSQL database and the real route handlers:

* a cross-tenant read and a read of a **non-existent** id return the **same status and the
  same body** (the anti-enumeration guarantee);
* a same-tenant role denial returns 403 with a message that names the role rule;
* a suspended school and a missing school selection return 403 from the context gate;
* a learner never receives `correctAnswer` or `explanation`, in any status.

`tests/tenant-authorization-db.test.ts` additionally asserts, for every protected
resource, that a cross-tenant id yields 404 and that the response body contains none of
the foreign identifiers.

---

## 6. Rules for future changes

1. A new route that reads a tenant-owned row must filter it in the query. Do not fetch it
   first and check the tenant afterwards — that turns a 404 into a 403 and breaks the
   anti-enumeration guarantee.
2. A new role check must be expressed as a **403** and must not be able to observe a row
   outside the caller's tenant.
3. A new route that needs to hide a resource from some roles but not others should use
   the query-level authorization helpers in `src/lib/assignment-access.ts` (404), not a
   post-fetch branch.
4. Do not introduce a status code other than 401 (not authenticated), 403 (the caller's
   own rights), or 404 (the resource is invisible) for authorization failures.
