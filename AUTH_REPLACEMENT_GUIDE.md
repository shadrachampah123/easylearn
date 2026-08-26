# EasyLearn Authentication Replacement Guide

This replacement preserves all existing pages and school features. The authentication rebuild affects only login, registration, sessions, database connectivity, health checks, and Vercel schema setup.

## Files to copy into an existing EasyLearn repository

Copy these files and folders with the same paths:

```text
src/app/api/auth/login/route.ts
src/app/api/auth/register/route.ts
src/app/api/auth/me/route.ts
src/app/login/page.tsx
src/app/register/page.tsx
src/lib/auth.ts
src/lib/env.ts
src/lib/database-errors.ts
src/db/index.ts
src/app/api/health/route.ts
drizzle.config.ts
vercel.json
.env.example
drizzle/
```

Do not copy `.env` to GitHub. It is local-only and contains secrets.

## GitHub replacement

From the repository root:

```bash
git checkout -b fix/auth-rebuild
git add src/app/api/auth src/app/login src/app/register src/lib/auth.ts src/lib/env.ts src/lib/database-errors.ts src/db/index.ts src/app/api/health/route.ts drizzle.config.ts vercel.json .env.example drizzle
git commit -m "Rebuild login and registration for Neon and Vercel"
git push -u origin fix/auth-rebuild
```

Create a pull request into `main`, merge it, and let Vercel deploy the merged commit. You can also push directly to `main` if that is your current workflow.

## Neon

1. Open the Neon project and choose the production branch and database.
2. Click **Connect**.
3. Enable the pooled connection option.
4. Copy the entire PostgreSQL URL, including `sslmode=require`.
5. Do not include `DATABASE_URL=` and do not add quotes when pasting into Vercel.

The included `vercel.json` runs this before every Vercel build:

```bash
npx drizzle-kit push --force
```

This creates or synchronizes all existing EasyLearn tables before Next.js is compiled. If the database URL is missing or invalid, the Vercel deployment fails instead of deploying a site with broken authentication.

## Vercel environment variables

Open **Vercel → Project → Settings → Environment Variables**.

Add:

```text
DATABASE_URL = the pooled Neon PostgreSQL URL
JWT_SECRET = a random value of at least 32 characters
```

Generate `JWT_SECRET` locally with:

```bash
openssl rand -base64 48
```

Enable both variables for:

- Production
- Preview
- Development

Delete any duplicate `DATABASE_URL` entries that point to localhost or an old Neon branch. Redeploy after changing variables.

## Verify the deployment

Open:

```text
https://YOUR-DOMAIN.vercel.app/api/health
```

A correct deployment returns:

```json
{
  "ok": true,
  "checks": {
    "databaseUrlConfigured": true,
    "jwtSecretConfigured": true,
    "databaseConnected": true,
    "schemaReady": true
  }
}
```

Then test registration with a brand-new email. Test login with that same email and password.

## Existing demo accounts

A new Neon database will not contain demo users until seeded. Run once:

```bash
curl -X POST https://YOUR-DOMAIN.vercel.app/api/seed
```

Then the existing demo admin login is:

```text
admin@cbism.edu
admin123
```

Change demo passwords before public launch.

## If Vercel build fails

Open **Vercel → Deployments → Failed deployment → Build Logs**.

Common results:

- `DATABASE_URL is required`: add the variable and redeploy.
- `password authentication failed`: copy a new Neon URL.
- `getaddrinfo` or timeout: use the pooled Neon URL.
- Schema push error on an incompatible old database: create a clean Neon database for this replacement or inspect the conflicting table in Neon SQL Editor.

## If the site builds but auth still fails

1. Open `/api/health`.
2. Open Vercel **Logs**.
3. Submit the login or registration form.
4. Filter by `/api/auth/login` or `/api/auth/register`.
5. The form now displays the safe actionable error; Vercel logs contain the full PostgreSQL cause.
