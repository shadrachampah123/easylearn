/**
 * The server-controlled policy for the CONTENT of an uploaded file.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 * Before this module, the `Content-Type` an uploaded file was served with came
 * from the file the *client* uploaded: `POST /api/uploads` stored
 * `file.type` (whatever the browser or script claimed) in `uploaded_files.mime_type`,
 * and `GET /api/files/<id>` served that column back as the `Content-Type`.
 *
 * A client controls that value completely. Uploading a file called `photo.png`
 * while declaring `Content-Type: text/html` was accepted, because the
 * extension allow-list only knows the extension `png`, and the declared MIME
 * type was only used to *narrow* the category — it was never used to decide
 * what the bytes are. The file was then stored with `mime_type = text/html`
 * and served back as `Content-Type: text/html`, `Content-Disposition: inline`,
 * from the application's own origin. Opening that URL executed the uploaded
 * script **in the application's authenticated origin**, with the session
 * cookie attached — a stored cross-site scripting vulnerability.
 *
 * The same hole applied to `image/svg+xml`: SVG is a document format that can
 * carry `<script>`, and it was served inline.
 *
 * ── The rule this module implements ───────────────────────────────────────────
 * The server decides what a file IS, from a server-controlled allow-list, and
 * checks that the file's bytes agree with that decision. The client's declared
 * MIME type is **never** used to decide what is safe to serve. It is only ever
 * used to produce a clearer error message.
 *
 *   1. The extension must be on the allow-list. The extension is the only
 *      part of the request the server stores, so it is the anchor.
 *   2. The file's bytes must match the signature of that extension — the
 *      server-controlled content type, not the client's, is the answer.
 *   3. The bytes must not look like HTML, SVG or XHTML, whatever the
 *      extension claims.
 *   4. The content type the server serves is the one in the allow-list. It is
 *      never `text/html`, `image/svg+xml`, `application/xhtml+xml` or any
 *      other scriptable type.
 *
 * A file whose bytes do not match its extension is REJECTED at upload time
 * rather than stored and served under a type it does not have.
 *
 * ── Deliberately not allowed ──────────────────────────────────────────────────
 * `html`, `htm`, `xhtml`, `svg`, `xml`, `mhtml` and `js` are not on the
 * allow-list at all, and there is no configuration that adds them. HTML and
 * SVG are document formats: they are rendered by the browser, they can carry
 * script, and they would run in the application's origin. Serving them
 * safely needs a separate origin that cannot reach the session — see
 * `docs/SECURITY_AUTHENTICATION.md`.
 */

import type { AttachmentCategory } from "./uploads";

/* ── Byte signatures ─────────────────────────────────────────────────────────── */

/** One contiguous run of bytes that must be present at a fixed offset. */
interface BytePart {
  offset: number;
  /** The bytes that must be present. */
  bytes: number[];
  /** Optional mask applied to the file's byte before it is compared. */
  mask?: number;
}

/** A signature: every part must match. */
export interface Signature {
  label: string;
  parts: BytePart[];
}

/** ASCII text as a byte array. */
function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

/** A signature that is a literal byte run at a fixed offset. */
function at(label: string, offset: number, text: string): Signature {
  return { label, parts: [{ offset, bytes: ascii(text) }] };
}

/**
 * A signature that is a literal byte run at a fixed offset, written as
 * numbers.
 *
 * Binary signatures are written this way on purpose: a signature such as the
 * ZIP header `50 4B 03 04` contains control characters, and spelling them as
 * numbers keeps the source readable and immune to editors and formatters that
 * would silently drop or rewrite them.
 */
function raw(label: string, offset: number, bytes: number[]): Signature {
  return { label, parts: [{ offset, bytes }] };
}

/** A signature made of several literal byte runs at fixed offsets. */
function parts(label: string, ...pieces: Array<[number, string]>): Signature {
  return {
    label,
    parts: pieces.map(([offset, text]) => ({ offset, bytes: ascii(text) })),
  };
}

/* ── The allow-list ──────────────────────────────────────────────────────────── */

/** What the server knows about one extension. */
export interface UploadContentRule {
  /** The category the file belongs to. */
  category: AttachmentCategory;
  /**
   * The content type the server serves. It is derived from the extension and
   * the file's own bytes — never from the client's declared MIME type.
   */
  contentType: string;
  /**
   * The signatures the file's bytes may match. When this list is empty the
   * format has no reliable signature (plain text), and only the
   * HTML/SVG/XHTML check applies.
   */
  signatures: Signature[];
}

const ZIP_SIGNATURES: Signature[] = [
  raw("ZIP local file header", 0, [0x50, 0x4b, 0x03, 0x04]),
  raw("ZIP empty archive", 0, [0x50, 0x4b, 0x05, 0x06]),
  raw("ZIP spanned archive", 0, [0x50, 0x4b, 0x07, 0x08]),
];

const OLE2_SIGNATURE: Signature[] = [
  {
    label: "OLE2 compound document",
    parts: [{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }],
  },
];

const ISOBMFF_SIGNATURES: Signature[] = [
  at("ISO base media (ftyp box)", 4, "ftyp"),
  at("ISO base media (moov box)", 4, "moov"),
  at("ISO base media (mdat box)", 4, "mdat"),
  at("ISO base media (wide box)", 4, "wide"),
];

/**
 * The server's allow-list: extension → category, served content type and the
 * byte signatures the file's contents must match.
 *
 * The content types here are the ones the server SERVES. They are chosen so
 * that none of them can execute script in this origin, and so that a browser
 * never has to guess: `X-Content-Type-Options: nosniff` is sent alongside.
 */
export const UPLOAD_CONTENT_RULES: Record<string, UploadContentRule> = {
  // ── Documents ───────────────────────────────────────────────────────────────
  pdf: {
    category: "document",
    contentType: "application/pdf",
    signatures: [at("PDF document", 0, "%PDF-")],
  },
  doc: {
    category: "document",
    contentType: "application/msword",
    signatures: OLE2_SIGNATURE,
  },
  docx: {
    category: "document",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    signatures: ZIP_SIGNATURES,
  },
  ppt: {
    category: "document",
    contentType: "application/vnd.ms-powerpoint",
    signatures: OLE2_SIGNATURE,
  },
  pptx: {
    category: "document",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    signatures: ZIP_SIGNATURES,
  },
  xls: {
    category: "document",
    contentType: "application/vnd.ms-excel",
    signatures: OLE2_SIGNATURE,
  },
  xlsx: {
    category: "document",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    signatures: ZIP_SIGNATURES,
  },
  rtf: {
    category: "document",
    contentType: "application/rtf",
    signatures: [at("RTF document", 0, "{\\rtf")],
  },
  odt: {
    category: "document",
    contentType: "application/vnd.oasis.opendocument.text",
    signatures: ZIP_SIGNATURES,
  },
  ods: {
    category: "document",
    contentType: "application/vnd.oasis.opendocument.spreadsheet",
    signatures: ZIP_SIGNATURES,
  },
  odp: {
    category: "document",
    contentType: "application/vnd.oasis.opendocument.presentation",
    signatures: ZIP_SIGNATURES,
  },
  // Plain text has no signature. It is the one format where the bytes cannot
  // be identified, so the HTML/SVG/XHTML check is what protects it — and it is
  // served as `text/plain` with `Content-Disposition: attachment`, so it is
  // never rendered as a document.
  txt: { category: "document", contentType: "text/plain; charset=utf-8", signatures: [] },

  // ── Images (raster only — SVG is deliberately absent) ───────────────────────
  png: {
    category: "image",
    contentType: "image/png",
    signatures: [
      {
        label: "PNG signature",
        parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
      },
    ],
  },
  jpg: {
    category: "image",
    contentType: "image/jpeg",
    signatures: [{ label: "JPEG SOI marker", parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] }],
  },
  jpeg: {
    category: "image",
    contentType: "image/jpeg",
    signatures: [{ label: "JPEG SOI marker", parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] }],
  },
  gif: {
    category: "image",
    contentType: "image/gif",
    signatures: [at("GIF87a image", 0, "GIF87a"), at("GIF89a image", 0, "GIF89a")],
  },
  webp: {
    category: "image",
    contentType: "image/webp",
    signatures: [parts("RIFF/WebP image", [0, "RIFF"], [8, "WEBP"])],
  },
  bmp: {
    category: "image",
    contentType: "image/bmp",
    signatures: [at("BMP bitmap", 0, "BM")],
  },

  // ── Audio ───────────────────────────────────────────────────────────────────
  mp3: {
    category: "audio",
    contentType: "audio/mpeg",
    signatures: [
      at("MP3 ID3 tag", 0, "ID3"),
      {
        label: "MP3 frame sync",
        parts: [
          { offset: 0, bytes: [0xff] },
          { offset: 1, bytes: [0xe0], mask: 0xe0 },
        ],
      },
    ],
  },
  wav: {
    category: "audio",
    contentType: "audio/wav",
    signatures: [parts("RIFF/WAVE audio", [0, "RIFF"], [8, "WAVE"])],
  },
  m4a: {
    category: "audio",
    contentType: "audio/mp4",
    signatures: ISOBMFF_SIGNATURES,
  },
  ogg: {
    category: "audio",
    contentType: "audio/ogg",
    signatures: [at("Ogg container", 0, "OggS")],
  },
  aac: {
    category: "audio",
    contentType: "audio/aac",
    signatures: [
      at("AAC ID3 tag", 0, "ID3"),
      {
        label: "AAC ADTS frame",
        parts: [
          { offset: 0, bytes: [0xff] },
          { offset: 1, bytes: [0xf0], mask: 0xf6 },
        ],
      },
    ],
  },
  flac: {
    category: "audio",
    contentType: "audio/flac",
    signatures: [at("FLAC stream", 0, "fLaC")],
  },

  // ── Video ───────────────────────────────────────────────────────────────────
  mp4: { category: "video", contentType: "video/mp4", signatures: ISOBMFF_SIGNATURES },
  m4v: { category: "video", contentType: "video/mp4", signatures: ISOBMFF_SIGNATURES },
  webm: {
    category: "video",
    contentType: "video/webm",
    signatures: [raw("EBML container", 0, [0x1a, 0x45, 0xdf, 0xa3])],
  },
  mkv: {
    category: "video",
    contentType: "video/x-matroska",
    signatures: [raw("EBML container", 0, [0x1a, 0x45, 0xdf, 0xa3])],
  },
  mov: { category: "video", contentType: "video/quicktime", signatures: ISOBMFF_SIGNATURES },
  avi: {
    category: "video",
    contentType: "video/x-msvideo",
    signatures: [parts("RIFF/AVI video", [0, "RIFF"], [8, "AVI "])],
  },

  // ── Archives ────────────────────────────────────────────────────────────────
  zip: { category: "zip", contentType: "application/zip", signatures: ZIP_SIGNATURES },
};

/**
 * Extensions that are never accepted, whatever else is configured.
 *
 * These are document formats: the browser renders them, and they can carry
 * script. Serving them safely needs a separate origin that cannot reach the
 * session — that design is not implemented here, so they are refused.
 */
export const FORBIDDEN_EXTENSIONS: ReadonlySet<string> = new Set([
  "html",
  "htm",
  "xhtml",
  "xht",
  "svg",
  "svgz",
  "xml",
  "mhtml",
  "mht",
  "js",
  "mjs",
  "swf",
  "jar",
  "hta",
  "vtt",
  "shtml",
  "php",
]);

/**
 * The content types that can execute script in a browsing context. A file
 * that is offered with one of these is refused outright.
 */
export const SCRIPTABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "application/xhtml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
]);

/**
 * The Content-Security-Policy sent with every uploaded-file response.
 *
 * `sandbox` puts a response that a browser treats as a DOCUMENT into an
 * opaque origin with scripting disabled. It is the second layer: the first
 * layer is that the server never serves a scriptable content type and never
 * renders an unknown file inline.
 *
 * `default-src 'none'` blocks every subresource of such a document.
 * `frame-ancestors 'none'` stops the file from being framed by any origin.
 *
 * This is the same value in `next.config.ts`, so the policy on a file response
 * does not depend on which of the two places wins.
 */
export const FILE_RESPONSE_CSP =
  "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The categories that may be shown inline (an `<img>`, `<video>` or `<audio>`
 * element) rather than downloaded.
 *
 * Only raster images and the media formats are inline. Everything else —
 * documents, archives — is downloaded. A document format is exactly the thing
 * that a browser renders as a page, so it must never be rendered in this
 * origin.
 *
 * Note that "pdf" is deliberately NOT inline: a PDF is a document format with
 * its own scripting surface, and it was already served as a download before
 * this module existed.
 */
export const INLINE_SAFE_CATEGORIES: ReadonlySet<string> = new Set(["image", "video", "audio"]);

/* ── Detection ──────────────────────────────────────────────────────────────── */

function matchesSignature(buffer: Buffer, signature: Signature): boolean {
  return signature.parts.every((part) => {
    if (part.offset + part.bytes.length > buffer.length) return false;
    return part.bytes.every((byte, index) => {
      const actual = buffer[part.offset + index];
      const mask = part.mask ?? 0xff;
      return (actual & mask) === (byte & mask);
    });
  });
}

/**
 * True when the first bytes of the file look like an HTML, SVG or XHTML
 * document.
 *
 * The check looks for the *document* markers — a doctype, an `<html>` root, an
 * SVG root or an XML prologue followed by SVG — and not for `<script>` on its
 * own, because a plain-text assignment that contains a code sample mentioning
 * `<script>` is a legitimate upload and is served as `text/plain` with a
 * download disposition, where it cannot execute.
 */
export function looksLikeMarkup(buffer: Buffer): boolean {
  // Strip a UTF-8 BOM at the BYTE level (the bytes are read as latin1 below,
  // so a decoded-character BOM would not match).
  let start = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    start = 3;
  }
  const head = buffer.subarray(start, start + 1024).toString("latin1");
  // Strip leading whitespace so a file that begins with a newline is still
  // recognised.
  const text = head.replace(/^[\s\u0000]+/, "");
  if (!text) return false;

  if (/^<!doctype\s+html/i.test(text)) return true;
  if (/^<html\b/i.test(text)) return true;
  if (/^<svg\b/i.test(text)) return true;
  if (/^<\?xml/i.test(text) && /<svg\b/i.test(text)) return true;
  return false;
}

/** The rule for an extension, or null when the extension is not allowed. */
export function ruleForExtension(extension: string): UploadContentRule | null {
  const key = extension.trim().toLowerCase();
  if (!key) return null;
  if (FORBIDDEN_EXTENSIONS.has(key)) return null;
  return UPLOAD_CONTENT_RULES[key] ?? null;
}

export interface ContentVerdict {
  ok: boolean;
  /** The server-determined content type. Only set when `ok` is true. */
  contentType?: string;
  /** The server-determined category. Only set when `ok` is true. */
  category?: AttachmentCategory;
  /** Why the file was refused. Never contains file content. */
  reason?: string;
}

/**
 * Decide what a file actually is.
 *
 * `declaredMimeType` is the type the client claimed. It is used for ONE
 * thing only: to produce a clearer error when the client asked for something
 * dangerous. It never decides what is served.
 */
export function verifyUploadContent(
  fileName: string,
  buffer: Buffer,
  declaredMimeType?: string | null
): ContentVerdict {
  const dot = fileName.lastIndexOf(".");
  const extension = dot < 0 ? "" : fileName.slice(dot + 1).trim().toLowerCase();

  const rule = ruleForExtension(extension);
  if (!rule) {
    return {
      ok: false,
      reason: `"${fileName}" is not a supported file type. Allowed: PDF and Office documents, plain text, PNG/JPEG/GIF/WEBP/BMP images, MP3/WAV/M4A/OGG/AAC/FLAC audio, MP4/WEBM/MOV/MKV/M4V/AVI video, and ZIP archives.`,
    };
  }

  /* A client that asks for a scriptable type is refused whatever the bytes
     turn out to be. This is a belt-and-braces check: the served type comes
     from the allow-list, never from the client. */
  const declared = (declaredMimeType || "").trim().toLowerCase().split(";")[0].trim();
  if (declared && SCRIPTABLE_CONTENT_TYPES.has(declared)) {
    return {
      ok: false,
      reason: `"${fileName}" declares the content type "${declared}", which a browser can execute. It was refused.`,
    };
  }

  if (looksLikeMarkup(buffer)) {
    return {
      ok: false,
      reason: `"${fileName}" contains HTML, SVG or XHTML markup. Such files are refused because a browser would run them in this application's origin.`,
    };
  }

  if (rule.signatures.length > 0) {
    const matched = rule.signatures.some((signature) => matchesSignature(buffer, signature));
    if (!matched) {
      return {
        ok: false,
        reason: `"${fileName}" does not look like the ${extension.toUpperCase()} file it claims to be. It was refused.`,
      };
    }
  }

  return { ok: true, contentType: rule.contentType, category: rule.category };
}

/**
 * The content type to serve a stored file with.
 *
 * The stored file name is `<uuid>.<extension>` (or an object key ending in
 * the same extension) and the extension was validated against the allow-list
 * when the file was uploaded, so it — not the stored `mime_type` column — is
 * what decides the served type.
 *
 * Files uploaded before this module existed, or with an extension that is not
 * on the allow-list, are served as `application/octet-stream` with a download
 * disposition: unknown content is never rendered inline.
 */
export function servedContentTypeFor(storedName: string): {
  contentType: string;
  category: AttachmentCategory | null;
  inline: boolean;
} {
  const dot = storedName.lastIndexOf(".");
  const extension = dot < 0 ? "" : storedName.slice(dot + 1).trim().toLowerCase();
  const rule = ruleForExtension(extension);
  if (!rule) {
    return { contentType: "application/octet-stream", category: null, inline: false };
  }
  return {
    contentType: rule.contentType,
    category: rule.category,
    inline: INLINE_SAFE_CATEGORIES.has(rule.category),
  };
}
