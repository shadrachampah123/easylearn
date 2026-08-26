# Fixing Login and Registration on Vercel

When the website loads but login and registration return an internal server error, the Next.js app is deployed but its Vercel functions cannot use the Neon database. Usually either `DATABASE_URL` is wrong or the Drizzle schema has not been applied.

## 1. Check the live diagnostic

Open this URL, replacing the domain with the live Vercel domain:

```text
https://YOUR-APP.vercel.app/api/health
```

Expected result after setup:

- `databaseUrlConfigured: true`
- `jwtSecretConfigured: true`
- `databaseConnected: true`
- `schemaReady: true`
- `ok: true`

The endpoint never returns the database URL or any secret.

## 2. Configure Vercel variables

In Vercel:

1. Open the EasyLearn project.
2. Open **Settings → Environment Variables**.
3. Add `DATABASE_URL`.
4. Its value must be only the complete Neon connection string. Do not paste `DATABASE_URL=` into the value field and do not wrap it in quotes.
5. Enable **Production**, **Preview**, and **Development**.
6. Add `JWT_SECRET` with a long random value of at least 32 characters.
7. Enable all three environments for it too.
8. Open **Deployments**, choose the latest deployment, select the menu, and click **Redeploy**. Environment changes do not update an already running deployment until it is redeployed.

## 3. Copy the correct Neon connection string

In Neon:

1. Open the EasyLearn project.
2. Click **Connect**.
3. Select the correct database and the `main` branch.
4. Prefer the pooled connection string for Vercel.
5. Ensure the copied URL ends with `sslmode=require` (extra Neon parameters are also fine).
6. Paste that URL into Vercel's `DATABASE_URL` value.

## 4. Apply the EasyLearn schema to Neon

The migration is committed under `drizzle/`.

From a local terminal or GitHub Codespace opened at the repository root:

### macOS, Linux, or GitHub Codespaces

```bash
export DATABASE_URL='PASTE_THE_NEON_CONNECTION_STRING'
npx drizzle-kit migrate
```

Alternatively, to synchronize the current schema directly:

```bash
export DATABASE_URL='PASTE_THE_NEON_CONNECTION_STRING'
npx drizzle-kit push
```

### Windows PowerShell

```powershell
$env:DATABASE_URL='PASTE_THE_NEON_CONNECTION_STRING'
npx drizzle-kit migrate
```

Do not use the local `127.0.0.1` database URL for this operation. The command must use the Neon URL.

## 5. Create the first demo accounts (optional)

After the schema is ready, send one POST request to the deployed seed endpoint:

### macOS/Linux

```bash
curl -X POST https://YOUR-APP.vercel.app/api/seed
```

### Windows PowerShell

```powershell
Invoke-RestMethod -Method POST -Uri 'https://YOUR-APP.vercel.app/api/seed'
```

Then test:

- Admin: `admin@cbism.edu` / `admin123`
- Teacher: `teacher@cbism.edu` / `teacher123`
- Parent: `parent@cbism.edu` / `parent123`
- Learner: `learner@cbism.edu` / `learner123`

Change demo passwords before a public launch.

## 6. Push this fix to GitHub and redeploy

```bash
git add .
git commit -m "Fix Neon authentication deployment"
git push origin main
```

If Vercel is connected to the GitHub repository, the push automatically creates a new deployment.

## 7. Read Vercel logs if health is still failing

1. Open Vercel → EasyLearn project → **Logs**.
2. Open the live app's `/api/health` route again.
3. Filter logs by `/api/health`, `/api/auth/login`, or `/api/auth/register`.
4. The app now returns a safe, actionable database message while the full technical error remains in Vercel logs.
