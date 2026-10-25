#!/usr/bin/env node
/**
 * Verify that the JWT secret configured in this environment satisfies the secret
 * policy in `src/lib/jwt-policy.ts`.
 *
 * Usage:
 *     JWT_SECRET=... npm run security:check-secret
 *
 * Exits 0 when the secret is usable, 1 when it is not. The secret itself is never
 * printed — only the reason it was rejected.
 *
 * This is the operator-facing counterpart of the runtime check: the application
 * refuses to sign or verify a token with an unacceptable secret, and this command
 * lets a deployment verify its configuration without having to provoke a 503.
 */

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
  process.execPath,
  [
    path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(REPO, "scripts", "check-jwt-secret.ts"),
  ],
  { stdio: "inherit", cwd: REPO },
);

process.exit(result.status === null ? 1 : result.status);
