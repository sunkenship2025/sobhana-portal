# WhatsApp delivery failure

**When to use this**

- A patient reports they didn't receive their report link
- `MessageLog` shows multiple `FAILED` rows for recent finalizations
- Owner dashboard's delivery metrics drop unexpectedly
- Webhook deliveries from Meta have stopped arriving

> **Reminder:** WhatsApp delivery is fire-and-forget by design (see [DECISIONS ADR-006](../DECISIONS.md)). Report finalization always succeeds even if delivery fails. The data is fine; the *notification* is what's broken. Don't panic-rollback finalization code.

---

## Pre-flight

- Backend admin login (to query `MessageLog` via owner audit UI or directly)
- Meta Business Suite access (WhatsApp number admin)
- Render dashboard (to read backend logs)
- Neon SQL editor (to inspect `MessageLog`)

---

## Step 1: Confirm scope

Is this one patient's number, one branch, or all delivery?

```sql
-- Recent message attempts:
SELECT status, COUNT(*) as count
FROM "MessageLog"
WHERE "createdAt" > now() - interval '1 hour'
GROUP BY status;
```

- **All `FAILED`** → systemic. Skip to Step 3.
- **Only one phone number is `FAILED`** → individual issue. Skip to Step 5.
- **Some `PENDING` (no `SENT`)** → notifications not even attempting; possibly env var / startup issue. See Step 2.
- **Most `SENT` but not `DELIVERED`** → Meta has the message but the patient's WhatsApp isn't receiving it. Could be patient's phone offline, account inactive, or template approval issue.

---

## Step 2: Notifications not attempting (`PENDING` only)

Symptom: `MessageLog` rows are stuck at `PENDING` and never transition to `SENT`/`FAILED`.

Probable causes:
1. **`WHATSAPP_ACCESS_TOKEN` env not set** in Render → backend's WhatsApp service is no-op. Check Render env config.
2. **Backend container crashed mid-call** → notification fired, log row written as `PENDING`, never updated. Check Pino logs around the timestamp.
3. **`notificationService` is silently catching the error** → it's designed not to throw; the failure should be in `MessageLog.failureReason`. If it's empty, our error path isn't recording. That's a bug worth fixing.

Quick check:
```bash
# Render dashboard → environment variables
# Confirm WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN are set and non-empty
```

If env is fine, manually trigger a send: finalize a test visit (with your own phone number registered as the patient — DON'T use a real patient for testing). Watch the Pino log live; should see calls to Meta Graph API and the `MessageLog` row's `status` updating.

---

## Step 3: Systemic failure

Symptom: every `MessageLog` row in the last hour is `FAILED`. `failureReason` is populated.

Group by reason:
```sql
SELECT "failureReason", COUNT(*) as count
FROM "MessageLog"
WHERE "createdAt" > now() - interval '1 hour' AND status = 'FAILED'
GROUP BY "failureReason"
ORDER BY count DESC;
```

Common reasons:

### "Authorization expired" / 401 from Meta

Your `WHATSAPP_ACCESS_TOKEN` expired or was revoked.

1. Generate a new token (Meta Business Suite → System Users → token).
2. Update Render env (see [`rotate-secrets.md`](rotate-secrets.md)).
3. Set a calendar reminder ~50 days before this token's expiry — long-lived tokens are ~60 days.

### "Template not approved" / 132012

You're trying to send a template message that Meta hasn't approved yet, or the template was rejected/disabled.

1. Meta Business Suite → WhatsApp Manager → Message Templates.
2. Find the template (e.g. `report_ready_v2`). Check status.
3. If rejected: read the rejection reason. Resubmit with corrections. Approval can take hours-to-days.
4. **Workaround during outage:** if the template is fully blocked, you can disable WhatsApp send entirely (set `WHATSAPP_ACCESS_TOKEN` to empty in Render — backend treats this as no-op). Manually inform patients via SMS / phone until template is restored.

### "Phone number not on WhatsApp"

The patient's number isn't a valid WhatsApp account.

1. Check `Patient.whatsappOptIn` — was the patient explicitly opted in, or did the system assume?
2. Update the patient record in admin → uncheck `whatsappOptIn`.
3. Inform the patient via SMS or phone call with the report link (use the staff UI's manual share, or copy the public report URL).

### Rate limit / 429

Meta enforces per-number-per-day quotas, and per-user template quotas. If we hit the limit:

1. Wait — quotas reset within hours.
2. Check Meta Business Suite → Quality Rating for the WABA. A "low" rating reduces quotas. Improve by ensuring template messages are relevant and consented.
3. **Long-term fix:** add a backoff queue (BullMQ on Redis) so notifications retry rather than failing permanently. Tracked in [DECISIONS ADR-006](../DECISIONS.md).

---

## Step 4: Webhook deliveries stopped

Symptom: `MessageLog` rows show `SENT` but never advance to `DELIVERED` / `READ`. Meta is sending webhook callbacks; we're not receiving them.

1. **Meta Business Suite → WhatsApp Configuration → Webhooks**. Check the webhook URL is correct (`https://<backend-url>/webhooks/whatsapp`).
2. Click "Send test event" from Meta side. Watch Render Pino logs for the incoming POST.
3. **If the POST never arrives:** backend may be rejecting it (auth middleware leaked into the public path?). Confirm `/webhooks/whatsapp` is mounted *before* `authMiddleware` in [`index.ts`](../../health-hub-backend/src/index.ts).
4. **If the POST arrives but webhook handling errors:** check Pino logs for parsing errors. Meta sometimes changes payload shapes — update `webhooks.ts` to handle the new shape.
5. **Verify token mismatch on the GET handshake:** `WHATSAPP_VERIFY_TOKEN` env in Render must match what's set in Meta's webhook config. If Meta's verification GET fails, webhook deliveries are paused until re-verified.

---

## Step 5: Single phone number failing

The most common case: one patient isn't getting their report. Almost always patient-side.

1. Look up the `MessageLog` row for that visit:
   ```sql
   SELECT * FROM "MessageLog"
   WHERE "contextType" = 'REPORT' AND "contextId" = '<visitId>'
   ORDER BY "createdAt" DESC;
   ```
2. Read `status` and `failureReason`.
3. Common patient-side issues:
   - Number not on WhatsApp (see Step 3)
   - Patient blocked the business number
   - Patient's WhatsApp account is inactive
   - Patient is in a region where WhatsApp is restricted
4. **Workaround:** copy the public report URL from the staff UI and share via SMS / phone call. Update `Patient.whatsappOptIn = false` so future reports don't try WhatsApp first.

---

## Step 6: Resending

There's no "resend" button in the staff UI today (this is a tracked feature gap). Manual resend:

1. Open the visit's report version detail in admin.
2. Get the `ReportAccessToken` row for that version.
3. Reconstruct the link:
   ```
   <PUBLIC_REPORT_BASE_URL>/<bearer-token>
   ```
   You'll need the original bearer — which we don't store, only the SHA-256 hash. So:
4. Issue a **new** token for the same `ReportVersion`:
   - Insert a new `ReportAccessToken` row with the same `reportVersionId` (token field = SHA-256 of a freshly generated bearer)
   - Or implement a "Resend report" endpoint (this is a small PR worth doing).
5. Send the new link to the patient via the appropriate channel.

---

## Verification

- [ ] `MessageLog` for the affected window: `FAILED` rows are dropping; new sends transitioning to `SENT` and `DELIVERED`
- [ ] Test send from your own staff account works end-to-end
- [ ] If you rotated a token: it appears in Render env and the manual test send works
- [ ] Patient confirms they received the message (if possible)

---

## What to log

- Date / time of issue
- Scope (all / one branch / one patient)
- Root cause (token expired / template issue / patient-side)
- Fix applied
- How many users were affected
- Whether any reports needed manual delivery
