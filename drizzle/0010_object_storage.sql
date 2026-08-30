-- 0010: Cloud object storage for file uploads (AWS S3 / Cloudflare R2 / MinIO)
-- Adds uploaded_files.storage_backend so file bytes can live in cloud object
-- storage instead of local disk.
--
--   storage_backend = 'local'  -> bytes live under UPLOAD_DIR (./storage/uploads)
--   storage_backend = 'object' -> stored_name holds the bucket object key
--
-- When object storage is configured, browsers PUT uploads straight to the
-- bucket via presigned URLs (bypassing Vercel's ~4.5 MB request-body limit, so
-- 100 MB videos upload fine) and GET /api/files/<id> redirects to a presigned
-- download URL. Local disk remains the default when no bucket is configured.

--> statement-breakpoint
ALTER TABLE "uploaded_files" ADD COLUMN IF NOT EXISTS "storage_backend" varchar(20) NOT NULL DEFAULT 'local';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploaded_files_storage_backend_idx" ON "uploaded_files" USING btree ("storage_backend");
