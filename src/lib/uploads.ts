/**
 * Shared file-upload rules for the assignment and submission modules.
 *
 * These constants/helpers are used by BOTH the client (FileUploader component
 * validates before it even starts a request) and the server (the /api/uploads
 * route enforces the exact same rules — the client check is just UX, the
 * server check is the real security boundary).
 *
 * Size rules:
 *  - Videos:  strict 100 MB limit per file (hard requirement).
 *  - Everything else: 50 MB per file.
 *
 * Keep this file free of server-only imports (db, fs, next/server) so it can
 * be imported from client components as well as route handlers.
 */

export type AttachmentCategory = "document" | "image" | "audio" | "video" | "zip";

/** Strict limit for a single video upload. */
export const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
/** Limit for any other single file (documents, PDFs, audio, images, archives). */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
/** Multipart overhead headroom — one 100 MB video plus boundaries/headers. */
export const MAX_REQUEST_SIZE_BYTES = MAX_VIDEO_SIZE_BYTES + 2 * 1024 * 1024;
/** Hard cap on the number of files per upload request. */
export const MAX_FILES_PER_REQUEST = 5;
/** Cap on the number of attachments an assignment/submission may reference. */
export const MAX_ATTACHMENTS = 5;

/** Extension → category. The single source of truth for what may be uploaded. */
export const ALLOWED_EXTENSIONS: Record<string, AttachmentCategory> = {
  // Documents & PDFs
  pdf: "document",
  doc: "document",
  docx: "document",
  ppt: "document",
  pptx: "document",
  xls: "document",
  xlsx: "document",
  txt: "document",
  rtf: "document",
  odt: "document",
  ods: "document",
  odp: "document",
  // Images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  // Audio
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  ogg: "audio",
  aac: "audio",
  flac: "audio",
  // Video
  mp4: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  m4v: "video",
  avi: "video",
  // Archives
  zip: "zip",
};

/** MIME prefixes that are accepted per category (server-side sanity check). */
const MIME_PREFIXES: Record<AttachmentCategory, string[]> = {
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument",
    "application/vnd.ms-",
    "application/rtf",
    "application/vnd.oasis.opendocument",
    "text/plain",
    "text/csv",
    "application/zip",
    "application/x-zip-compressed",
  ],
  image: ["image/"],
  audio: ["audio/"],
  video: ["video/"],
  zip: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
};

/** `file.accept` value for the file picker. */
export const UPLOAD_ACCEPT = [
  ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.rtf,.odt,.ods,.odp",
  ".png,.jpg,.jpeg,.gif,.webp,.bmp",
  ".mp3,.wav,.m4a,.ogg,.aac,.flac",
  ".mp4,.webm,.mov,.mkv,.m4v,.avi",
  ".zip",
].join(",");

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).trim().toLowerCase();
}

export function categoryForExtension(name: string): AttachmentCategory | null {
  const ext = fileExtension(name);
  return ALLOWED_EXTENSIONS[ext] ?? null;
}

/**
 * Category for a file, checking MIME type first and falling back to the
 * extension. Returns null for unsupported files.
 */
export function categoryForFile(name: string, mimeType: string | undefined): AttachmentCategory | null {
  const byExtension = categoryForExtension(name);
  const cleanMime = (mimeType || "").toLowerCase();

  if (cleanMime) {
    const byMime = (Object.keys(MIME_PREFIXES) as AttachmentCategory[]).find((category) =>
      MIME_PREFIXES[category].some((prefix) => cleanMime.startsWith(prefix))
    );
    if (byMime && byExtension && byMime !== byExtension) {
      // Extension says one thing, MIME says another — do not trust the upload.
      return null;
    }
    if (byMime) return byMime;
  }
  return byExtension;
}

export function isVideoFile(name: string, mimeType?: string): boolean {
  return categoryForFile(name, mimeType) === "video";
}

/** The size limit that applies to a single file, in bytes. */
export function sizeLimitFor(name: string, mimeType?: string): number {
  return isVideoFile(name, mimeType) ? MAX_VIDEO_SIZE_BYTES : MAX_FILE_SIZE_BYTES;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** Attachment metadata stored in the `attachments` jsonb of assignments/submissions. */
export interface StoredAttachment {
  fileId: string;
  name: string;
  type: AttachmentCategory | string;
  size: number;
  url: string;
}

export function isStoredAttachment(value: unknown): value is StoredAttachment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.fileId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.url === "string"
  );
}

/** Normalise a jsonb attachments value into a StoredAttachment array. */
export function storedAttachments(value: unknown): StoredAttachment[] {
  if (Array.isArray(value)) return value.filter(isStoredAttachment);
  return [];
}

export const CATEGORY_ICONS: Record<AttachmentCategory, string> = {
  document: "📄",
  image: "🖼️",
  audio: "🎵",
  video: "🎥",
  zip: "📦",
};

export const CATEGORY_LABELS: Record<AttachmentCategory, string> = {
  document: "Document",
  image: "Image",
  audio: "Audio",
  video: "Video",
  zip: "Archive",
};

export function isInlinePreviewable(type: string): boolean {
  return type === "image" || type === "video" || type === "audio" || type === "pdf";
}
