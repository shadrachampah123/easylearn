#!/usr/bin/env bash
# Mutation check for the security fixes on this branch.
#
# Each mutation breaks ONE protection. The matching test suite MUST fail.
# A mutation that survives means the test does not actually guard anything.
#
# ─────────────────────────────────────────────────────────────────────────────
# THIS SCRIPT MODIFIES THE WORKING TREE. It refuses to run unless the tree is
# clean, and it restores the tree from HEAD after every mutation. Do NOT run
# it with uncommitted work: the restore is `git checkout -- .`, which
# discards uncommitted changes.
#
# It is NOT part of `npm test` and CI does not run it. Run it from the
# repository root with a clean tree:
#
#     git status --porcelain     # must be empty
#     bash tests/manual/mutation-check.sh
#
# The branches and the base commit it is meant for are named at the top.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSING TO RUN: the working tree is not clean."
  echo "This script restores the tree from HEAD with 'git checkout -- .',"
  echo "which would discard uncommitted work. Commit or stash first."
  exit 2
fi

pass=0; fail=0
declare -a SURVIVORS=()

restore() {
  git checkout -- . 2>/dev/null
  if [ -n "$(git status --porcelain)" ]; then
    echo "   (WARNING: tree not clean after restore)"
    exit 3
  fi
}

# run_mutation <name> <suite-command...>
run_mutation() {
  local name="$1"; shift
  echo "── MUTATION: $name"
  local out code summary
  out=$("$@" 2>&1); code=$?
  summary=$(echo "$out" | grep -E "📊 Results:" | tail -1)
  if [ $code -ne 0 ] || echo "$out" | grep -qE "❌ FAIL"; then
    echo "   ✓ KILLED  ($summary)"
    echo "$out" | grep -E "❌ FAIL" | head -3 | sed 's/^/       /'
    pass=$((pass+1))
  else
    echo "   ✗ SURVIVED  ($summary)  <-- the test does not guard this"
    SURVIVORS+=("$name")
    fail=$((fail+1))
  fi
  restore
  echo
}

UPLOAD_SUITE=(npx tsx tests/upload-content.test.ts)
CSRF_SUITE=(npx tsx tests/csrf-policy.test.ts)
COOKIE_SUITE=(npx tsx tests/cookie-auth.test.ts)

echo "════════════ upload-content policy ════════════"

python3 - <<'PY'
p = "src/app/api/files/[id]/route.ts"
s = open(p, encoding="utf-8").read()
old = '    const contentType = served.contentType;'
new = '    const contentType = row.mimeType || "application/octet-stream";'
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the file route serves the stored mime_type column again" "${UPLOAD_SUITE[@]}"

python3 - <<'PY'
p = "src/lib/upload-content.ts"
s = open(p, encoding="utf-8").read()
old = "  if (rule.signatures.length > 0) {"
new = "  if (false && rule.signatures.length > 0) {"
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the byte-signature check is removed" "${UPLOAD_SUITE[@]}"

python3 - <<'PY'
p = "src/lib/upload-content.ts"
s = open(p, encoding="utf-8").read()
old = "  if (looksLikeMarkup(buffer)) {"
new = "  if (false && looksLikeMarkup(buffer)) {"
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the HTML/SVG/XHTML content check is removed" "${UPLOAD_SUITE[@]}"

python3 - <<'PY'
p = "src/lib/upload-content.ts"
s = open(p, encoding="utf-8").read()
old = "  if (declared && SCRIPTABLE_CONTENT_TYPES.has(declared)) {"
new = "  if (false && declared && SCRIPTABLE_CONTENT_TYPES.has(declared)) {"
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "a client-declared scriptable MIME type is accepted" "${UPLOAD_SUITE[@]}"

python3 - <<'PY'
p = "src/lib/upload-content.ts"
s = open(p, encoding="utf-8").read()
old = 'export const INLINE_SAFE_CATEGORIES: ReadonlySet<string> = new Set(["image", "video", "audio"]);'
new = 'export const INLINE_SAFE_CATEGORIES: ReadonlySet<string> = new Set(["image", "video", "audio", "document", "zip"]);'
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "documents and archives are served inline again" "${UPLOAD_SUITE[@]}"

python3 - <<'PY'
p = "src/app/api/files/[id]/route.ts"
s = open(p, encoding="utf-8").read()
j = s.index("const baseHeaders")
block = s[j:j+900]
assert '"Content-Security-Policy": FILE_RESPONSE_CSP,' in block
s = s[:j] + block.replace('      "Content-Security-Policy": FILE_RESPONSE_CSP,\n', "", 1) + s[j+900:]
open(p, "w", encoding="utf-8").write(s)
PY
run_mutation "the SERVED file response no longer sends a CSP" "${UPLOAD_SUITE[@]}"

python3 - <<'PY'
p = "src/app/api/uploads/route.ts"
s = open(p, encoding="utf-8").read()
old = '            mimeType: verdict.contentType!.slice(0, 150),'
new = '            mimeType: (file.type || "application/octet-stream").slice(0, 150),'
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the upload route stores the client's declared MIME type again" "${UPLOAD_SUITE[@]}"

python3 - <<'PY'
p = "src/app/api/uploads/presign/route.ts"
s = open(p, encoding="utf-8").read()
old = "    const contentType = rule.contentType;"
new = '    const contentType = mimeType || "application/octet-stream";'
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the presigned PUT binds the client's MIME type again" "${UPLOAD_SUITE[@]}"

python3 - <<'PY'
p = "next.config.ts"
s = open(p, encoding="utf-8").read()
old = '        source: "/api/files/:path*",'
new = '        source: "/api/never-matches/:path*",'
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the file route has no CSP rule in next.config.ts" "${UPLOAD_SUITE[@]}"

echo "════════════ cross-site request policy ════════════"

python3 - <<'PY'
p = "src/lib/csrf.ts"
s = open(p, encoding="utf-8").read()
old = "  const trustProxy = trustsProxyHeaders();"
new = "  const trustProxy = true;"
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the forwarded headers are trusted by default again" "${CSRF_SUITE[@]}"

python3 - <<'PY'
p = "src/lib/csrf.ts"
s = open(p, encoding="utf-8").read()
old = "  const configured = getConfiguredPublicOrigin();"
new = "  const configured = null;"
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the configured public origin is ignored" "${CSRF_SUITE[@]}"

python3 - <<'PY'
p = "src/lib/csrf.ts"
s = open(p, encoding="utf-8").read()
old = """  const values = allValues(header);
  return values.length === 1 ? values[0] : null;"""
new = """  const values = allValues(header);
  return values.length === 0 ? null : values[0];"""
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the first element of a multi-valued forwarded host is trusted" "${CSRF_SUITE[@]}"

python3 - <<'PY'
p = "src/lib/csrf.ts"
s = open(p, encoding="utf-8").read()
old = "export function getRequestOrigins(request: Request): string[] {"
new = 'export function getRequestOrigins(request: Request): string[] {\n  return ["https://app.example.test"];'
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the request origin is hard-coded" "${CSRF_SUITE[@]}"

python3 - <<'PY'
p = "src/lib/csrf.ts"
s = open(p, encoding="utf-8").read()
old = '  const raw = (process.env[TRUST_PROXY_HEADERS_ENV] || "").trim().toLowerCase();\n  return raw === "true" || raw === "1" || raw === "yes";'
new = '  const raw = (process.env[TRUST_PROXY_HEADERS_ENV] || "").trim().toLowerCase();\n  return true;'
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the trusted-proxy opt-in is always on" "${CSRF_SUITE[@]}"

echo "════════════ browser call-path guard ════════════"

GUARD_TARGET="src/components/admin/UsersManager.tsx"

python3 - <<'PY'
p = "src/components/admin/UsersManager.tsx"
s = open(p, encoding="utf-8").read()
old = "export default function UsersManager"
new = "const aliasedFetch = fetch;\n\nexport default function UsersManager"
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "the global fetch is aliased" "${COOKIE_SUITE[@]}"

python3 - <<'PY'
p = "src/components/admin/UsersManager.tsx"
s = open(p, encoding="utf-8").read()
old = "export default function UsersManager"
new = "const { fetch: destructuredFetch } = window;\n\nexport default function UsersManager"
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
PY
run_mutation "fetch is destructured off a global object" "${COOKIE_SUITE[@]}"

python3 - <<'PY'
p = "src/components/admin/UsersManager.tsx"
s = open(p, encoding="utf-8").read()
s += '\nvoid window["fetch"];\n'
open(p, "w", encoding="utf-8").write(s)
PY
run_mutation "fetch is reached through bracket notation" "${COOKIE_SUITE[@]}"

python3 - <<'PY'
p = "src/components/admin/UsersManager.tsx"
s = open(p, encoding="utf-8").read()
s += '\nvoid navigator.sendBeacon("/api/audit", "x");\n'
open(p, "w", encoding="utf-8").write(s)
PY
run_mutation "navigator.sendBeacon is used" "${COOKIE_SUITE[@]}"

python3 - <<'PY'
p = "src/components/admin/UsersManager.tsx"
s = open(p, encoding="utf-8").read()
s += "\nvoid new XMLHttpRequest();\n"
open(p, "w", encoding="utf-8").write(s)
PY
run_mutation "an XMLHttpRequest is built outside the audited upload component" "${COOKIE_SUITE[@]}"

python3 - <<'PY'
p = "src/components/dashboard/FileUploader.tsx"
s = open(p, encoding="utf-8").read()
s = s.replace("new XMLHttpRequest()", "new window.XMLHttpRequest()")
open(p, "w", encoding="utf-8").write(s)
PY
run_mutation "the audited upload component stops using XMLHttpRequest" "${COOKIE_SUITE[@]}"

echo "═════════════════════════════════════════════════"
echo "Mutations killed: $pass    survived: $fail"
if [ ${#SURVIVORS[@]} -gt 0 ]; then
  printf 'SURVIVED: %s\n' "${SURVIVORS[@]}"
  exit 1
fi
echo "Every mutation was caught."
