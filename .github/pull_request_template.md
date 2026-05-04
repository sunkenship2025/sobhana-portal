<!--
Title: short, imperative — e.g. "feat(diagnostics): add referral source to visit creation"
Don't reference issues in the title; link them in the body.
-->

## Summary

<!-- 1-3 sentences. What changes from the user's perspective. Not "I refactored X" — "Lab techs can now do Y" or "Visit creation no longer fails when …". -->

## Why

<!-- The motivation. Bug report? User request? Tech debt cleanup? Compliance? Link the issue / commit / Slack thread / customer report. -->

## What changed

<!-- Bulleted list — keep it skimmable. Group by area if the diff spans multiple. -->

- 
- 

## Risk and reversibility

<!-- Be honest. -->

- **Blast radius:** <!-- which feature(s)/role(s) are affected if this is wrong? -->
- **Reversible by:** <!-- "git revert" / "manual data fix in Prisma Studio" / "redeploy the previous container" / "irreversible — requires migration rollback" -->
- **Migration?** <!-- "no" / "yes — additive, safe" / "yes — destructive, see Migration notes below" -->

## Test plan

<!-- How you verified this works. Be specific. "Tested locally" is not enough. -->

- [ ] Backend `npm run type-check` passes
- [ ] Frontend `npx tsc --noEmit` passes
- [ ] Backend `npm run build` passes
- [ ] Frontend `npm run build` passes
- [ ] Manual smoke test of the changed flow in dev — describe what you clicked through:
- [ ] (If schema change) migration applied cleanly to a non-prod DB
- [ ] (If API change) request/response shapes verified — no breaking changes to FE consumers
- [ ] (If UI change) tested in Chrome and Safari
- [ ] (If finance/payout/report-finalization) cross-checked the resulting numbers manually

## Migration notes

<!-- Only if this PR requires action at deploy. Examples: env var added, data backfill needed, downtime expected. Link the runbook if one applies. Otherwise delete this section. -->

## Documentation

- [ ] User-impacting change → entry added to [`documentation/CHANGELOG.md`](../documentation/CHANGELOG.md) under `[Unreleased]`
- [ ] Architectural decision → ADR added to [`documentation/DECISIONS.md`](../documentation/DECISIONS.md)
- [ ] New env var → documented in [`README.md`](../README.md) env-var table
- [ ] New runbook-worthy operational concern → added to [`documentation/runbooks/`](../documentation/runbooks/)

## Screenshots / clips

<!-- For UI changes: before/after. Drag-drop. Delete this section for non-UI PRs. -->

## Linked issues

<!-- Closes #NNN -->
