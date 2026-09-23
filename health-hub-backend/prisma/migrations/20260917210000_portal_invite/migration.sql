-- Portal invite: one nullable timestamp, nothing else.
--
-- Non-null = "invited on WhatsApp, has not replied yet". It is cleared in the
-- same UPDATE that writes their password hash, so an unanswered invite leaves no
-- credential behind anywhere. Every existing account gets NULL, which is the
-- "not pending" state — no current login, password or role is touched by this.
ALTER TABLE "User" ADD COLUMN "portalInviteAt" TIMESTAMP(3);
