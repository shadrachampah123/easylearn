/**
 * Where uploaded file bytes live on disk.
 *
 * Server-only module (uses node:path / process.cwd) — do not import from
 * client components. Defaults to <project>/storage/uploads (git-ignored);
 * set UPLOAD_DIR to point elsewhere (e.g. a mounted volume).
 */
import path from "node:path";

export function uploadStorageDir(): string {
  const configured = (process.env.UPLOAD_DIR || "").trim();
  if (configured) return configured;
  return path.join(process.cwd(), "storage", "uploads");
}
