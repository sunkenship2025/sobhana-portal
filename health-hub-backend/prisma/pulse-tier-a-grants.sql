-- Pulse Tier A — reach the data the centre already records but Pulse could not see.
--
-- Column-level, not table-level, on the same principle as the worklist grants: Pulse gets what
-- it needs to COUNT and COMPARE, never the contact details or the content. An access log is
-- analytically interesting because of when and how something was opened, not because of whose
-- IP address opened it; a WhatsApp thread is interesting because of how fast we reply, not
-- because of what the patient said.
--
-- Run as the database owner.

-- Did the patient actually open the report we sent? Sends were countable; opens were not.
GRANT SELECT ("id", "reportVersionId", "accessType", "accessedVia", "userId", "createdAt")
  ON "ReportAccessLog" TO analytics_ro;

-- Same for bills.  patientName / actorPhone / ipAddress / userAgent deliberately withheld.
GRANT SELECT ("id", "visitId", "billNumber", "accessType", "accessedVia", "userId", "createdAt")
  ON "BillAccessLog" TO analytics_ro;

-- Which flagged actions were reviewed, and what was decided. Without this every anomaly looks
-- permanently open, and the staff leaderboard cannot distinguish "checked and fine" from "never
-- looked at".  "note" is free text written by staff and stays out.
GRANT SELECT ("id", "anomalyEventId", "status", "actorUserId", "actorName", "createdAt", "updatedAt")
  ON "AnomalyTriage" TO analytics_ro;

-- The commission rate cards. Pulse could say a doctor is owed a number but never why that rate.
GRANT SELECT ON "ReferralCategoryRate" TO analytics_ro;
GRANT SELECT ON "ReferralDoctorCategoryRule" TO analytics_ro;
GRANT SELECT ON "ReferralDoctorProductRule" TO analytics_ro;
GRANT SELECT ON "DoctorPayoutRule" TO analytics_ro;

-- Outsourcing: who we send work to and at what rate.  Contact columns withheld.
GRANT SELECT ("id", "name", "labNumber", "rateType", "ratePercent", "rateAmountInPaise", "isActive", "createdAt")
  ON "ExternalLab" TO analytics_ro;

-- Patient WhatsApp threads — metadata only. Message BODY and mediaUrl are patient content and
-- are never granted; direction and timing answer "do patients reply, and how fast do we", which
-- is the analytic question, without reading anyone's messages.
GRANT SELECT ("id", "conversationId", "direction", "messageType", "status", "isAutoReply", "staffUserId", "createdAt")
  ON "ConversationMessage" TO analytics_ro;
-- phone is a unique identifier and lastPreview is the text of a patient's message; both out.
GRANT SELECT ("id", "patientId", "branchId", "assignedToId", "status", "lastInboundAt",
              "lastMessageAt", "unreadCount", "autoRepliedAt", "createdAt", "updatedAt")
  ON "Conversation" TO analytics_ro;
