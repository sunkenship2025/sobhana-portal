# Regenerate a failed report

**When to use this**

- A patient reports their report link doesn't work
- A staff user says PDF preview is hanging or showing errors
- Sentry shows PDF generation errors (`pdfGenerationService` / `mergedReportPdfService` stack traces)
- Puppeteer is stuck (`/health` shows `puppeteer: degraded`)

---

## Pre-flight

- The visit ID or report version ID of the affected report (ask the user; or grep Pino logs)
- Render dashboard (to view backend logs and restart if needed)
- Backend admin / staff login

---

## Step 1: Reproduce

1. Open the staff finalized-report URL for that visit:
   ```
   https://<backend-url>/api/visits/diagnostic/<visitId>/finalized-report/pdf?mode=digital
   ```
   With your `Authorization` header. Or click the report button in the staff UI.
2. Watch the response:
   - **Returns a PDF** → the renderer works for you. The user's link is the issue (probably token expired or the link broken in transit). Move to Step 4.
   - **Returns 500** → the renderer is broken for this report. Continue to Step 2.
   - **Hangs / times out** → Puppeteer is wedged. Skip to Step 3.

---

## Step 2: Inspect the failure

1. **Read Pino logs** for the timeframe of your reproduction. Filter on the request ID (echoed in the response header `X-Request-Id`).
2. **Read Sentry** — same timeframe. The stack trace usually pinpoints which step failed:
   - **`reportSnapshotService`** — snapshot generation. Means the source data is broken (missing patient, missing test result, FK pointing at deleted row). Don't regenerate the snapshot — the snapshot is supposed to be immutable. Investigate the source.
   - **`reportRendererService`** — HTML rendering. Usually a missing signature image, broken template variable, or malformed snapshot JSON.
   - **`inlineSignatureImage`** — the signature file is gone from disk. Either the file was deleted or the path in the snapshot is wrong. The PDF will render but without the signature; this is a warning, not an error.
   - **`pdfGenerationService`** — Puppeteer failed. Could be a malformed HTML, a Chromium crash, or a timeout. See Step 3.
   - **`mergedReportPdfService`** — pdf-lib failed to merge external uploads. Probably a corrupt uploaded PDF. The base render works; the merge fails.
3. Decide: is the underlying *snapshot* broken, or just the *render*?

### If the snapshot is broken
The snapshot is meant to be immutable. **Don't edit it.** Instead:
1. Open Neon SQL editor. Inspect the `ReportVersion.panelsSnapshot` JSON for the affected version.
2. If a referenced entity is missing (a deleted signing doctor, a hard-deleted test result) — the right fix is at that level (restore the entity, or write a renderer that handles the missing case gracefully).
3. If the snapshot itself is malformed, you may need to **finalize a new ReportVersion**. Do this only with explicit consent from the user / patient — the new finalization will produce a *different* PDF and a *different* token. Communicate clearly.

### If the render is broken
The snapshot is fine; rendering is the bug. Fixing the bug in the renderer code is a normal PR — no special handling needed. Once deployed, the next request to render the same snapshot will succeed.

For external upload merge failures specifically:
1. Try the base report (without merge): `?skipMerged=true` if implemented, or by hitting `/api/visits/diagnostic/:id/finalized-report/pdf?mode=digital`.
2. If the base works, the bug is isolated to the upload merge. Look at the offending `ExternalReportUpload`'s `r2Key`. Try fetching the raw PDF from R2:
   ```bash
   curl <r2-public-url>/<r2-key> > /tmp/upload.pdf
   pdfinfo /tmp/upload.pdf  # or open it in a viewer
   ```
   If the PDF is corrupt: delete (soft-delete) the `ExternalReportUpload` row. Re-merge will skip it.

---

## Step 3: Puppeteer is wedged

Symptoms: `/health` shows `puppeteer: degraded` or `unhealthy`. PDF requests hang for 30+ seconds. Multiple Sentry events with timeouts.

The Chromium process is stuck. Restart fixes it.

1. **Render dashboard → backend service → "Manual Deploy" → "Clear cache and deploy"** (or "Restart").
2. Wait for the new container to pass healthcheck (1–2 minutes).
3. Watch Pino startup logs — should see `"PDF service warmed up"` (or equivalent — Puppeteer warmup line).
4. Re-try the failing report.

If Puppeteer wedges repeatedly:
- The base image may be missing a Chromium dep — check Render build logs for warnings during `apt-get install`.
- The visit's HTML may be massive (huge report with many results) and Puppeteer is struggling. Profile: time `reportRendererService.renderReportHtml(snapshot)` separately to see if it's the HTML gen or PDF gen that's slow.

---

## Step 4: User's link is broken (token issue)

1. Open the visit's `ReportAccessToken` row in Neon SQL editor:
   ```sql
   SELECT id, "reportVersionId", "expiresAt", "accessCount", "lastAccessedAt"
   FROM "ReportAccessToken"
   WHERE "reportVersionId" = '<report-version-id>';
   ```
2. Common causes:
   - **`expiresAt` set and in the past** — token expired. Re-issue a new token via the staff UI's "Resend report" action (if implemented), or by inserting a new `ReportAccessToken` row pointing at the same `ReportVersion`. Send the new link to the patient.
   - **No row exists** — the report was finalized but `reportAccessService.createToken()` didn't run. This is a bug — investigate. Workaround: insert manually:
     ```sql
     -- generate a new token in your shell first:
     -- node -e "console.log(require('nanoid').nanoid(12))"
     INSERT INTO "ReportAccessToken" (id, token, "reportVersionId", "createdAt")
     VALUES (gen_random_uuid(), '<sha256-hash-of-new-bearer>', '<reportVersionId>', now());
     ```
   - **Bearer mismatch** — the user's link's bearer doesn't hash to any stored token. Either user-error (truncated paste, mistyped URL) or someone is brute-forcing. Check the request log for the IP and frequency. If the user pasted a partial URL: re-send the correct link.

---

## Verification

- [ ] Affected report renders in staff UI
- [ ] Public token URL serves the PDF
- [ ] No new error pattern in Sentry for 15 minutes
- [ ] If Puppeteer was restarted: PDF generation latency back to normal (<5s for a single-page report)

---

## What to log

- Visit ID / report version ID
- Symptom (which user / link / endpoint)
- Root cause (one line)
- Action taken
- Whether the user was contacted with a new link / regenerated report
