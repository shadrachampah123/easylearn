/*
 * Real-browser probe: what does Chromium DO with the response headers the
 * object store returns?
 *
 * The local-storage path in PR #40 serves files with `nosniff`, a sandboxing
 * CSP and a server-determined content type. The OBJECT-STORAGE path cannot:
 * the object store serves the bytes itself, and S3-compatible stores let a
 * presigned GET override only `response-content-type`,
 * `response-content-disposition` and `response-cache-control`. `nosniff`
 * and `Content-Security-Policy` cannot be forced onto that response.
 *
 * This probe reproduces each header combination the object store could return
 * and reports what Chromium actually does, so the residual risk is stated from
 * evidence rather than from the specification.
 *
 * Run:  node tests/manual/browser-content-type-sniffing-probe.js
 * It starts its own static server on PORT (default 3499) and drives Chromium.
 */
"use strict";

const http = require("http");
const puppeteer = require("puppeteer-core");

const PORT = Number(process.env.PROBE_PORT || 3499);
const CHROMIUM = process.env.CHROMIUM_EXECUTABLE || "";

const HTML = Buffer.from(
  `<!DOCTYPE html><html><body><script>window.__XSS_EXECUTED__=true;document.title='PWNED'</script><p>html</p></body></html>`
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const SANDBOX_CSP =
  "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** A real, playable 0.1 s silent WAV (PCM, 8 kHz mono). */
function makeWav() {
  const sampleRate = 8000;
  const samples = 800;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A WAV that is NOT a valid RIFF file, used as a stand-in video body. */
const NOT_REAL_VIDEO = Buffer.from("not a real mp4 body");

/**
 * The page the preview check runs on. It loads the file responses exactly as
 * the application does — an `<img>`, an `<audio>` and a `<video>` pointing at
 * `/api/files/<id>` — but from this probe's own origin so the headers under
 * test are the ones that matter.
 */
const PREVIEW_PAGE = `<!DOCTYPE html><html><body>
<img id="i" src="/real-png-inline-nosniff">
<audio id="a" src="/real-wav" preload="metadata"></audio>
<video id="v" src="/real-mp4" preload="metadata"></video>
</body></html>`;

/** The header sets under test. */
const CASES = [
  {
    id: "image-png-inline-nosniff",
    label: "image/png + inline + nosniff (the LOCAL path)",
    body: HTML,
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": SANDBOX_CSP,
    },
  },
  {
    id: "image-png-inline-no-nosniff",
    label: "image/png + inline, NO nosniff (the OBJECT-STORE path today)",
    body: HTML,
    headers: { "Content-Type": "image/png", "Content-Disposition": "inline" },
  },
  {
    id: "image-png-inline-sandbox-no-nosniff",
    label: "image/png + inline + sandbox CSP but NO nosniff",
    body: HTML,
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": "inline",
      "Content-Security-Policy": SANDBOX_CSP,
    },
  },
  {
    id: "octet-stream-inline-no-nosniff",
    label: "application/octet-stream + inline, NO nosniff",
    body: HTML,
    headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "inline" },
  },
  {
    id: "octet-stream-attachment-no-nosniff",
    label: "application/octet-stream + attachment, NO nosniff",
    body: HTML,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=\"x.bin\"",
    },
  },
  {
    id: "text-plain-inline-no-nosniff",
    label: "text/plain + inline, NO nosniff",
    body: HTML,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "inline" },
  },
  {
    id: "text-plain-attachment-no-nosniff",
    label: "text/plain + attachment, NO nosniff (what the app actually sends for .txt)",
    body: HTML,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"notes.txt\"",
    },
  },
  {
    id: "real-png-inline-nosniff",
    label: "a REAL PNG + inline + nosniff + sandbox (the LOCAL preview path)",
    body: PNG,
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": SANDBOX_CSP,
    },
  },
  {
    id: "real-png-inline-sandbox-no-nosniff",
    label: "a REAL PNG + inline + sandbox, NO nosniff (the OBJECT-STORE preview path)",
    body: PNG,
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": "inline",
      "Content-Security-Policy": SANDBOX_CSP,
    },
  },
];

async function main() {
  if (!CHROMIUM) {
    console.error("CHROMIUM_EXECUTABLE is not set — a real browser is required.");
    process.exit(2);
  }

  const server = http.createServer((request, response) => {
    const id = (request.url || "").replace(/^\//, "").split("?")[0];
    if (id === "preview-page") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(PREVIEW_PAGE);
      return;
    }
    /* The media responses carry exactly the headers the application sends. */
    if (id === "real-wav") {
      const body = makeWav();
      response.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": SANDBOX_CSP,
        "Content-Length": body.length,
      });
      response.end(body);
      return;
    }
    if (id === "real-mp4") {
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": SANDBOX_CSP,
        "Content-Length": NOT_REAL_VIDEO.length,
      });
      response.end(NOT_REAL_VIDEO);
      return;
    }
    const testCase = CASES.find((c) => c.id === id);
    if (!testCase) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { ...testCase.headers, "Content-Length": testCase.body.length });
    response.end(testCase.body);
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "shell",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const results = [];
  try {
    for (const testCase of CASES) {
      const page = await browser.newPage();
      const consoleLines = [];
      page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
      page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error}`));

      let status = null;
      try {
        const response = await page.goto(`http://127.0.0.1:${PORT}/${testCase.id}`, {
          waitUntil: "load",
          timeout: 20000,
        });
        status = response ? response.status() : null;
      } catch (error) {
        consoleLines.push(`navigation: ${error.message}`);
      }

      const executed = await page
        .evaluate(() => window.__XSS_EXECUTED__ === true)
        .catch(() => false);
      const title = await page.title().catch(() => "");
      const shape = await page
        .evaluate(() => ({
          contentType: document.contentType,
          scriptElements: document.querySelectorAll("script").length,
          htmlElements: document.querySelectorAll("html").length,
          bodyElements: document.querySelectorAll("body").length,
          text: document.body ? document.body.innerText.slice(0, 80) : "",
        }))
        .catch(() => ({ contentType: "", scriptElements: 0, htmlElements: 0, bodyElements: 0, text: "" }));

      results.push({
        id: testCase.id,
        label: testCase.label,
        status,
        executed,
        title,
        /* A document is only "rendered as HTML" when the browser actually
           parsed it as HTML: `document.contentType` is then "text/html" and a
           `<body>` element exists. Chrome's PLAIN-TEXT viewer also has a body
           element, but its contentType stays "text/plain" and no <script>
           element is created. */
        renderedAsHtml: shape.contentType === "text/html",
        contentType: shape.contentType,
        scriptElements: shape.scriptElements,
        bodyText: shape.text.replace(/\s+/g, " ").trim().slice(0, 60),
        console: consoleLines.filter((l) => !/Failed to load resource/.test(l)).slice(0, 3),
      });
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log("\n🧪 What Chromium does with each header combination\n");
  let dangerous = 0;
  for (const result of results) {
    const verdict = result.executed
      ? "❌ SCRIPT EXECUTED"
      : result.renderedAsHtml
        ? "⚠️  rendered as an HTML document (no script)"
        : "✅ not rendered as a document";
    if (result.executed) dangerous++;
    console.log(`${verdict}`);
    console.log(`   case:      ${result.label}`);
    console.log(`   status:    ${result.status}   title: ${JSON.stringify(result.title)}`);
    console.log(`   document.contentType: ${result.contentType}   <script> elements: ${result.scriptElements}`);
    console.log(`   body text: ${JSON.stringify(result.bodyText)}`);
    if (result.console.length) console.log(`   console:   ${JSON.stringify(result.console)}`);
    console.log("");
  }
  console.log(`⚠️  ${dangerous} of ${results.length} header combinations executed script.\n`);

  /* ── The preview check: do the application's file headers break the
       image / audio / video previews? ── */
  console.log("🖼️  Preview check: the application's file headers on real media\n");
  const previewBrowser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "shell",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const previewPage = await previewBrowser.newPage();
  const previewConsole = [];
  const previewResponses = [];
  previewPage.on("console", (message) => previewConsole.push(`${message.type()}: ${message.text()}`));
  previewPage.on("pageerror", (error) => previewConsole.push(`pageerror: ${error}`));
  previewPage.on("response", (response) => {
    previewResponses.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"] || "",
    });
  });
  await previewPage.goto(`http://127.0.0.1:${PORT}/preview-page`, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const preview = await previewPage.evaluate(() => {
    const image = document.getElementById("i");
    const audio = document.getElementById("a");
    const video = document.getElementById("v");
    return {
      imageComplete: image ? image.complete : null,
      imageNaturalWidth: image ? image.naturalWidth : null,
      audioReadyState: audio ? audio.readyState : null,
      audioDuration: audio ? audio.duration : null,
      audioError: audio ? audio.error ? audio.error.code : null : null,
      videoNetworkState: video ? video.networkState : null,
      videoReadyState: video ? video.readyState : null,
      videoError: video ? video.error ? video.error.code : null : null,
    };
  });
  const cspInPreview = previewConsole.filter((line) => /Content Security Policy|Refused to/i.test(line));
  console.log(`   image: complete=${preview.imageComplete} naturalWidth=${preview.imageNaturalWidth}`);
  console.log(`   audio: readyState=${preview.audioReadyState} duration=${preview.audioDuration} error=${preview.audioError}`);
  console.log(`   video: networkState=${preview.videoNetworkState} readyState=${preview.videoReadyState} error=${preview.videoError}`);
  console.log(`   responses: ${JSON.stringify(previewResponses.map((r) => `${r.status} ${r.contentType} ${r.url.split("/").pop()}`))}`);
  console.log(`   CSP violations in the console: ${cspInPreview.length}`);
  if (cspInPreview.length) console.log(`   ${JSON.stringify(cspInPreview.slice(0, 3))}`);
  console.log("");

  let previewFailures = 0;
  if (!(preview.imageComplete === true && preview.imageNaturalWidth > 0)) {
    console.error("❌ FAIL: the image preview did not decode under the application's file headers");
    previewFailures++;
  } else {
    console.log("✅ PASS: the image preview decodes under the application's file headers (the sandbox CSP does not break images)");
  }
  if (!(preview.audioReadyState >= 1)) {
    console.error("❌ FAIL: the audio element did not load the resource");
    previewFailures++;
  } else {
    console.log("✅ PASS: the audio element loaded the resource under the application's file headers");
  }
  const videoFetched = previewResponses.some((r) => r.url.endsWith("/real-mp4") && r.status === 200);
  if (!videoFetched) {
    console.error("❌ FAIL: the video element did not fetch the resource");
    previewFailures++;
  } else {
    console.log("✅ PASS: the video element fetched the resource under the application's file headers (decoding not verified — no sample video in the sandbox)");
  }
  if (cspInPreview.length > 0) {
    console.error("❌ FAIL: the preview page logged a Content-Security-Policy violation");
    previewFailures++;
  } else {
    console.log("✅ PASS: the preview page logged no Content-Security-Policy violation");
  }
  await previewPage.close();
  await previewBrowser.close();
  await new Promise((resolve) => server.close(resolve));

  console.log(`\n📊 Summary: ${dangerous} dangerous header combination(s), ${previewFailures} preview failure(s).`);
  if (dangerous > 0 || previewFailures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Probe failed:", error);
  process.exitCode = 1;
});
