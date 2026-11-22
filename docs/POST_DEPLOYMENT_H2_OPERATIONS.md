# Post-deployment H-2 operations — alerts, uptime monitoring, and the storage probe

Written 2026-11-19, after PR #70 was merged and deployed. Covers the three operator tasks
that **cannot be done from the repository** because they need Vercel or uptime-monitor
access this work is not authorised to use:

1. log alerting
2. external uptime monitoring
3. invoking the optional object-storage live probe

**Nothing in this document has been configured.** Where a step is a dashboard action, it
says so explicitly. No feature is described here that was not verified against Vercel's
published documentation on 2026-11-19; the source is cited beside each claim.

---

## 0. What "H-2 is complete" means

Three different states get conflated. Keep them apart:

| State | Meaning | Current |
| --- | --- | --- |
| **Code complete** | The instrumentation, logging, boundaries, redaction and health reporting exist, are tested, and are deployed | **Yes** — PR #70 merged, Production runs `ead529a` |
| **Operationally complete** | Someone is being *notified* when those signals fire | **No** — no alert, no monitor, no drain |
| **Verified in Production** | A real incident produced a notification an operator acted on | **No** — has not happened yet |

The code can be complete while an outage still goes unnoticed, because a log line that
nobody reads is not monitoring. That is what the rest of this document fixes.

---

## 1. What actually reaches Vercel

The application writes one JSON object per event to stdout (`info`, `debug`) or stderr
(`warn`, `error`). Vercel captures function console output as **runtime logs**. The fields
that matter for routing:

| Field | Example | Use |
| --- | --- | --- |
| `level` | `"error"` | `error` is stderr; `warn` is stderr too |
| `event` | `"health.check_failed"` | stable, machine-matchable name |
| `requestId` | `"a3f…"` | joins a browser report or a health response to the server line |
| `env` | `"production"` | `VERCEL_ENV` |
| `error.code` | `"ECONNREFUSED"` | stable; alert on this, not on message text |

**No secret reaches these lines.** Every field, message and error passes through
`src/lib/log-redaction.ts` before serialisation: connection strings (scheme kept,
credentials and host dropped), JWTs, `Bearer`/`Basic` credentials, cookie headers, bare
session cookies, `Authorization` with any scheme, `AKIA…`/`ASIA…` key ids, presigned-URL
parameters, email addresses, high-entropy blobs, and secret-named `key=value` pairs.
`tests/observability-h2.test.ts` proves this with a positive control (unredacted input
*fails* the suite) and a counterweight (identifiers must survive).

`EASY_LEARN_LOG_LEVEL` defaults to `info`. `debug` is suppressed in Production on purpose:
every line carries the same fields an alert would need, and a metered log platform charges
for the ones nobody reads.

### The events worth alerting on

| # | Event | Level | What it means | Severity |
| --- | --- | --- | --- | --- |
| 1 | `server.startup` **with** `"level":"error"` | error | Booted with a broken JWT secret or database URL. Sign-in will fail for every user | Page immediately |
| 2 | `server.startup_failed` | warn | The startup *report* failed. Observability itself is degraded | Investigate |
| 3 | `request.error` | error | An error escaped a route or render. `routePath` + `requestId` identify it | Triage |
| 4 | `health.check_failed` | error | `/api/health` could not answer | Triage — likely a database outage |
| 5 | `health.session_revocation_unavailable` | error | `users.session_version` missing and unrepairable → **every authenticated request is 503** | Page |
| 6 | `health.login_throttle_unavailable` | error | `login_attempts` missing and unrepairable → **every login is 503** | Page |
| 7 | `health.schema_probe_failed` | error | Schema state unknown; `ok:true` is withheld | Triage |
| 8 | `client_error.fatal` | error | The root layout failed for a real user | Notify |
| 9 | `client_error.rate_limited` | warn | Error reports are being dropped for one source | Investigate |
| 10 | `health.object_storage.suppressed` | error | The redaction safety net fired. Treat as a bug in the storage section | Notify |
| 11 | `health.object_storage.probe_failed` | warn | Only on `?deep=1`; the store is unreachable | Watch |
| 12 | `health.object_storage.sign_failed` | warn | The probe could not sign its request; credentials are wrong | Watch |

A repeated `server.startup` with `"level":"error"` is worse than one occurrence: it means
the instance is being recycled and failing every time — a crash loop rather than a bad
config on one cold start. Alert on **two or more in 15 minutes**.

---

## 2. Vercel log alerts — what Vercel can and cannot do

This section is deliberately blunt, because the common assumption is wrong.

### What Vercel's built-in alerting actually is

From Vercel's **Alerts** documentation (fetched 2026-11-19,
`https://vercel.com/docs/alerts`):

- Alerts are available on **Pro and Enterprise with Observability Plus**.
- Built-in monitor types are **Error anomaly** and **Usage anomaly**. Error anomaly
  "fires when a route's five-minute error count is unusually high compared to its recent
  baseline", grouped by **route and HTTP status group**, and "B y default, error anomalies
  track 5xx status codes".
- Custom monitors (Observability Plus) evaluate **Observability metrics or ratios** —
  request counts, status codes, durations, regions — with threshold or anomaly conditions.

**There is no built-in "notify me when a log line contains `event:health.check_failed`"
feature.** Vercel's alerts are *metric/status* based, not *log-content* based. Any document
that promises log-pattern alerting inside Vercel is describing something Vercel does not
ship. Notification of log content requires a **Log Drain** to a tool that can query it.

### What to configure in Vercel anyway (worth doing, does not need a drain)

These catch the outages that manifest as HTTP status changes, which is most of them:

1. **Error anomaly, 5xx, Production only.**
   Dashboard → **Team Settings → Alerts → Add Monitor** → Trigger **Error anomaly** →
   HTTP group **5xx** → scope to this project → Notifications: **Vercel Notifications**
   (email) and/or a **Slack** channel.
   → Catches: every 503 from `/api/health`, the fail-closed auth path (events 5 and 6),
   and unhandled route errors.

2. **A custom monitor on `/api/health` returning non-200** (requires Observability Plus).
   Custom monitor → metric query on request count filtered to `httpStatus >= 400` and
   `path:/api/health`, threshold `gt 0`, window `5m`.
   → Catches a health failure faster than an anomaly baseline will.

3. **Usage anomaly** is enabled by default and needs no action.

**Verify rather than assume.** After creating a monitor, Vercel's own documentation states
that **error anomalies start only after Observability Plus has been active for 24 hours**
and **usage anomalies after 3 days**. A monitor created today will not fire tonight. Do not
treat "the monitor exists" as "the monitor works" until that window has passed.

### If you need log-content alerting (events 1–12 above, exactly)

That requires a **Log Drain**, available on Pro and Enterprise
(`https://vercel.com/docs/drains/using-drains`):

1. **Team Settings → Drains → Add Drain**.
2. Choose **Logs**, select this project, **Production** environment.
3. Pick a destination. A drain can go to a custom HTTPS endpoint or a Marketplace logging
   service. The receiving tool — not Vercel — provides the matching and the notification.
4. In that tool, create rules on the JSON fields, for example:
   - `level = "error"` → page
   - `event = "health.session_revocation_unavailable"` → page
   - `event = "server.startup" AND level = "error"` → page
   - `event = "client_error.fatal"` → notify

The log schema Vercel delivers includes `level`, `message`, `requestId`, `path`,
`statusCode`, `environment`, `source` and `timestamp`
(`https://vercel.com/docs/drains/reference/logs`). The application's own `event` and
`error.code` survive inside `message`, because the whole JSON line is the message.

**This is a paid capability and has not been procured.** Choosing a vendor is an owner
decision, not an engineering one. Until it exists, items 1–12 are readable but not
alerting.

### The minimum that costs nothing

- Turn on **Vercel Notifications** for the team (web/email/push) so Vercel's own alerts
  reach someone.
- Configure the **external uptime monitor** in §3. It is free at the tiers that matter
  here and covers the one signal that matters most: the site is down.
- Subscribe the team to Vercel's **Deployment Failed** notifications, so a broken build
  never silently leaves old code running.

---

## 3. External uptime monitoring

The repository cannot create this; it needs a monitor account and a dashboard action. Any
of Better Stack, UptimeRobot, Pingdom, Checkly or a self-hosted `curl` cron will do. The
configuration is the same everywhere.

### Target

```
https://easylearn-six.vercel.app/api/health
```

**Plain `GET`. Do not use `?deep=1` for the routine check** — see §4 for why.

### A successful response

HTTP **200** with a JSON body containing **`"ok": true`**, for example:

```json
{
  "ok": true,
  "service": "EasyLearn API",
  "checks": {
    "requestId": "…",
    "databaseUrlConfigured": true,
    "jwtSecretConfigured": true,
    "databaseConnected": true,
    "schemaReady": true,
    "optionalMigrations": { "login_attempts": true, "session_revocation": true, "…": true },
    "migrationDetail": { "composite_tenant_foreign_keys": { "expected": 26, "present": 0, "valid": 0 } },
    "objectStorage": { "configured": true, "state": "configured-unverified", "checked": false }
  },
  "message": "Login and registration services are ready."
}
```

Set the monitor to assert **both**:

- status code is `200`, **and**
- the body contains `"ok":true` (a body check, not just a status check — a 200 with
  `ok:false` is a failure, and some proxies rewrite statuses).

### What each non-200 means

| Status | Body `message` (abridged) | Meaning | Act |
| --- | --- | --- | --- |
| **200** | "Login and registration services are ready." | Database reachable, schema compatible, both security-critical features present | none |
| **503** | "EasyLearn cannot connect to Neon…" | Database unreachable or the URL is wrong | check Neon; **page** if it persists past 2 intervals |
| **503** | "…users table is missing or incompatible…" | Core schema missing | run the migration procedure |
| **503** | "…session revocation is unavailable…" | Every authenticated request is failing closed | run `node run-migration.js`; **page** |
| **503** | "…login throttling is unavailable…" | Every sign-in is failing closed | run `node run-migration.js`; **page** |
| **503** | "The authentication database is unavailable…" | The health check itself threw | read the matching log line via `requestId` |
| **5xx other** | — | Platform-level failure | check Vercel status |

### Interval and failure policy

- **Interval: 60 seconds.** The endpoint performs one small query and one schema probe; it
  is cheap. Faster than 60 s buys nothing for a low-traffic application and can trip Vercel
  usage accounting; slower than 5 minutes means an outage can outlast a support call.
- **Timeout: 10 seconds.** The endpoint's own work is bounded well below that.
- **Alert after 2 consecutive failures**, not 1. A single 502/504 immediately after a
  deploy is a cold start, not an incident.
- **Re-notify every 30 minutes** while failing, so it is not a one-shot email at 03:00.
- **Notify on recovery**, so the "all clear" is as visible as the alarm.

### Failure notifications

Configure these in the monitor's own dashboard (the exact menu differs by vendor):

1. **Email** to an address someone reads, not a distribution list nobody owns.
2. **A channel that makes noise** — Slack, SMS, or a push notification. Email alone is
   routinely missed.
3. **Escalation:** if still failing after 15 minutes, notify a second person.

**Then test it.** Put the monitor on a pause–resume cycle, or point it briefly at a path
that 404s, and confirm a notification actually arrives at the destination that matters.
An untested alert is a guess.

### Optional second monitor (low frequency)

If object storage is configured in Production, add a **separate** monitor on

```
https://easylearn-six.vercel.app/api/health?deep=1
```

every **15–30 minutes**, asserting `"state":"verified"` inside `checks.objectStorage`.
Alert on `"state":"error"` only. This is the check that would have caught the C-1 upload
outage. It is deliberately not the 60-second monitor: it makes a network request to the
object store (see §4).

---

## 4. The object-storage live probe

### What `state` means

| `state` | `checked` | Meaning |
| --- | --- | --- |
| `disabled` | `false` | No storage configured; local disk is in use. Not an error |
| `misconfigured` | `false` | Some required variables set, some missing. `missingVariables` names them (names only) |
| `configured-unverified` | `false` | All variables present; **nothing has been sent to the store**. The honest default |
| `verified` | `true` | A signed request reached the store and it answered 200 or 404 |
| `error` | `true` | A signed request was attempted and failed, or timed out |

`configured-unverified` is **not** a failure. It is the truthful answer for an endpoint
that performed no I/O. Reporting `verified` without having contacted the store would be a
lie, and that is the specific lie H-2 exists to prevent.

### How to run the probe by hand

It is a `GET`, so it needs no CSRF token and no authentication:

```bash
curl -sS -D - "https://easylearn-six.vercel.app/api/health?deep=1" | sed -n '1,20p'
```

Look at `checks.objectStorage`:

- `"state":"verified"`, `"reachable":true`, `"latencyMs":42` → the store accepted the
  application's credentials and answered for the probe key.
- `"state":"error"` → read `reason`: `live_check_timeout`, `live_check_http_error`
  (the store answered but with a status that is not 200/404 — usually 403, meaning the
  signature or key is wrong) or `live_check_transport_error` (could not connect at all).

### What it verifies, and what it does not

**Verifies:** the endpoint, bucket and credentials in Production are accepted by the
object store for a **signed `HEAD`** on `health/probe-not-an-object`. A `404` is a pass —
it means the store authenticated the request and reported that the probe key does not
exist.

**Does not verify:**

- **Writability.** A `HEAD` reads nothing and writes nothing. A bucket that accepts `HEAD`
  but rejects `PUT` (wrong CORS, read-only token) still reports `verified`.
- **Browser CORS.** The upload path is a browser `PUT` with a preflight. That is what the
  C-1 incident actually involved, and only a real browser upload exercises it.
- **CDN/public-URL behaviour**, multipart paths, or quota.

So `verified` means "configured and reachable", not "uploads work end to end". The only
proof of uploads is an upload.

### Cost and safety

- One signed `HEAD`, `redirect: "manual"`, hard timeout
  (`EASY_LEARN_STORAGE_PROBE_TIMEOUT_MS`, default 2500 ms, clamped 250–10000).
- No retries, no body read, no bucket listing.
- The URL is a one-minute presigned URL, discarded after use.
- **The endpoint is unauthenticated and not rate-limited.** Anyone who can reach `/api/health`
  can make Production perform that outbound request. It is one small request with a
  timeout, which is why this is acceptable, but it is the reason `?deep=1` must not be the
  60-second monitor and must not be sent by a public status page on every poll.

### If it reports `error`

1. Re-run once by hand — a transient store blip is real.
2. `live_check_http_error` with the store answering **403** → the access key or secret is
   wrong, or the bucket name is wrong. Rotate/verify in the Vercel project settings. Do not
   paste the values into a ticket; the log line deliberately contains none of them.
3. `live_check_timeout` → check Cloudflare's status page before changing anything.
4. Remember that a healthy probe does not mean uploads work; ask a user to try one.

---

## 5. Status after this review

| Item | State |
| --- | --- |
| Edge Runtime warning | **Fixed** — `process.version` no longer appears in the Edge graph; build is warning-free |
| Request correlation | **Verified in Production** — id present on the response and on the matching log line |
| Redaction | **Verified** by test, including nested `cause` chains |
| `/api/health` reporting | **Improved** — reports migration *progress*, not only a boolean |
| Vercel alert monitors | **Not configured** — owner action (§2) |
| Log drain / log-content alerts | **Not procured** — owner decision, paid capability (§2) |
| External uptime monitor | **Not configured** — owner action (§3) |
| Storage deep probe | **Available on demand**; not scheduled (§4) |
| Migration 0018 | **Not applied** — administrator-gated, see `docs/PRODUCTION_PREFLIGHT_0019_0018.md` |
