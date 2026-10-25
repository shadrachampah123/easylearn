-- Session revocation (Risk #1): per-user session version that is bumped on logout.
-- A JWT whose `sessionVersion` claim does not match the user's current version is
-- treated as revoked. This makes logout invalidate previously issued tokens (up to
-- 24h expiry) without a separate revocation table. Existing tokens without the claim
-- are treated as version 0 for backwards compatibility.
-- Applied lazily via src/lib/schema-resilience.ts `session_revocation` feature
-- (ALTER TABLE IF NOT EXISTS) for disposable DBs; production should run:
--   ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS users_session_version_idx ON users (session_version);
