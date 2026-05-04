# Rotate secrets

**When to use this**

- A secret has leaked (committed `.env`, screenshot in chat, ex-employee, suspected breach)
- Scheduled rotation (we should do all secrets quarterly at minimum — we don't yet, this is the runbook)
- Rotating in response to a security report

This runbook covers: `JWT_SECRET`, database credentials, R2 keys, WhatsApp tokens, Sentry DSN.

---

## Pre-flight

- Render dashboard access (Environment Group + Service env editor)
- Vercel dashboard access (project env editor)
- Neon dashboard access (database role management)
- Cloudflare dashboard access (R2 API tokens)
- Meta Business Suite access (WhatsApp access tokens)
- A note open to track what you've rotated and what's still pending — don't trust your memory mid-rotation

Allow ~30 minutes per secret. Rotating `JWT_SECRET` will log every user out — schedule it for off-hours.

---

## General principles

1. **Generate the new secret first.** Have it copied somewhere safe (1Password / Doppler / encrypted note) before touching the old one.
2. **Update production env, not code.** None of these go in `package.json`, source files, or `.env` committed to git.
3. **Restart the service** after env change so it picks up the new value. Render auto-restarts on env change; Vercel rebuilds on env change.
4. **Verify the service is healthy** with the new value before considering rotation complete.
5. **Revoke the old secret** at the source after the new one is verified. Order matters — if you revoke before the new value is live, you take down the service.

---

## Procedure: `JWT_SECRET`

The hardest one because it logs every user out.

1. **Generate a new secret** (32+ random bytes):
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
2. **Open Render dashboard → Backend service → Environment**.
3. Update `JWT_SECRET` to the new value. Save. Render redeploys (~2 minutes).
4. **Verify**:
   ```bash
   curl https://<backend-url>/health
   # → 200 OK
   # Old tokens issued before the rotation will fail with 401 — expected.
   ```
5. **Communicate** in the user channel: "Authentication has been rotated. Everyone needs to log in again. Sorry for the interruption."
6. **Done.** No "old" location to revoke — JWTs are stateless and the new secret invalidates all old tokens automatically.

**If the rotation breaks something** (login broken for everyone): revert to the previous `JWT_SECRET` in Render env, redeploy. Investigate before retrying.

---

## Procedure: `DATABASE_URL` / `DIRECT_DATABASE_URL` (Neon)

Neon Postgres credentials.

1. **Open Neon dashboard → project → "Roles"**.
2. Click **Reset password** on the active role (typically `neondb_owner`). Copy the new connection strings — both pooled (`DATABASE_URL`) and direct (`DIRECT_DATABASE_URL`).
3. **Update Render env**: `DATABASE_URL` and `DIRECT_DATABASE_URL` to the new strings. Save.
4. Render redeploys. The container restart re-establishes the connection pool with the new password.
5. **Verify**:
   ```bash
   curl https://<backend-url>/health
   # → checks.postgres should be "ok"
   ```
6. **Done.** The old password is automatically invalidated by Neon when you reset.

If anything is connecting from outside Render (a local dev machine, an analytics tool, a backup script) — those will start failing. Update them too.

---

## Procedure: R2 access keys (Cloudflare)

External report uploads use S3-compatible R2 keys.

1. **Cloudflare dashboard → R2 → Manage R2 API Tokens**.
2. **Create new token** with the same permissions as the old one (Read + Write to the project's bucket). Copy the access key ID and secret.
3. Update Render env:
   - `R2_ACCESS_KEY_ID` ← new ID
   - `R2_SECRET_ACCESS_KEY` ← new secret
   - (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` unchanged)
4. Render redeploys.
5. **Verify**:
   - Upload a test file via the External Uploads UI for any visit
   - Confirm it appears in the bucket
   - Confirm the merged report PDF for that visit successfully includes the upload
6. **Revoke the old token** in Cloudflare dashboard.

---

## Procedure: WhatsApp Cloud API token (Meta)

Meta Business / WhatsApp tokens come in two flavors: short-lived (24h) and long-lived (~60 days). We use the long-lived system-user token.

1. **Meta Business Suite → System Users → Generate new token** for the same system user.
2. Copy the token. Note the expiry date (set a calendar reminder — 50 days, before it actually expires).
3. Update Render env: `WHATSAPP_ACCESS_TOKEN` to the new token.
4. Render redeploys.
5. **Verify**:
   - Manually trigger a WhatsApp send (finalize a test visit's report and watch it deliver to the test phone number)
   - Or `curl` the API directly with the new token:
     ```bash
     curl -X GET "https://graph.facebook.com/v18.0/<PHONE_NUMBER_ID>" \
       -H "Authorization: Bearer <new-token>"
     ```
6. **Revoke the old token** in Meta Business Suite.

If the verify token (`WHATSAPP_VERIFY_TOKEN`, used for webhook handshake) needs rotating: same procedure, but you'll also need to update the webhook configuration in Meta to use the new verify token, otherwise Meta won't be able to re-handshake.

---

## Procedure: `SENTRY_DSN`

DSNs are public-by-design (they go in client code), but if a DSN is being abused (someone pumping noise) you can rotate.

1. **Sentry dashboard → Project Settings → Client Keys (DSN) → Rotate / disable old**.
2. Update Render env: `SENTRY_DSN` to the new value.
3. Update Vercel env: `VITE_SENTRY_DSN` (or whichever the frontend reads) if applicable.
4. Both services redeploy.
5. **Verify** events from the new DSN appear in Sentry — trigger a deliberate error and watch.

---

## Procedure: After a leak (committed `.env`, screenshot, etc.)

Don't go in order. Do all rotations now. Mark them off as you go:

- [ ] `JWT_SECRET`
- [ ] `DATABASE_URL` + `DIRECT_DATABASE_URL`
- [ ] `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY`
- [ ] `WHATSAPP_ACCESS_TOKEN` (+ verify token if leaked)
- [ ] `SENTRY_DSN` (only if the leak gives an attacker write access to your event stream)
- [ ] `REDIS_URL` (rotate the Redis password / regenerate the connection string)
- [ ] Any other API keys (Render API key, Vercel API key — if those leaked, rotate via each platform's dashboard)

Then:

- [ ] `git rm --cached health-hub-backend/.env` — confirm `.env` is in `.gitignore`. Push.
- [ ] If the leak was via a public commit on a forked / public repo, consider the leak permanent and treat the rotation as urgent.
- [ ] Document the incident in your incident log (date, scope, what was rotated, who was notified). Even if it's just for your own records.
- [ ] If the leak compromised user data, [`SECURITY.md`](../../SECURITY.md) disclosure obligations may apply.

---

## What to log

- The date and time of each rotation
- The reason (scheduled / leak / breach response)
- Who performed it
- Confirmation that the old credential was revoked (not just rotated to a new value)
- Any user-facing impact (who got logged out, what failed during the window)

A simple text note in `documentation/runbooks/_log/<date>.md` is enough. Don't put the actual secrets in the log — only the metadata.
