/**
 * Engine outcome codes, in words.
 *
 * ITS OWN FILE SO IT CAN BE CHECKED. Eight codes reached the Activity feed and the
 * "Why" filter as raw SCREAMING_SNAKE — the whole reply vocabulary, plus the
 * suppressed-visit record the spec asks for by name — because nothing compared this
 * map against what the engine actually emits. automations-check now does, and it can
 * only import this if it pulls in no React and no API client.
 */
export const REASON_LABEL: Record<string, string> = {
  ENROLLED: 'Enrolled',
  WAITING: 'Waiting',
  CHECK_TRUE: 'Checked — yes',
  CHECK_FALSE: 'Checked — not yet',
  SENT: 'Sent',
  ALREADY_SENT: 'Already sent',
  COUPON_ISSUED: 'Offer issued',
  STOPPED_GOAL_MET: 'Came in',
  STOPPED_BY_STEP: 'Finished',
  STOPPED_BY_STAFF: 'Stopped by staff',
  STOPPED_AUTOMATION_STOPPED: 'Automation stopped',
  CONVERSION_REVERSED: 'No longer counted',
  MISSED_WINDOW: 'Too late to send',
  HELD_OUT: 'Control group',
  DECEASED: 'Patient has died',
  NO_PHONE: 'No usable phone',
  PHONE_OPTED_OUT: 'Replied STOP',
  NOT_OPTED_IN_MARKETING: 'Never agreed to offers',
  LINK_DISABLED: 'Online access switched off',
  CRITICAL_VALUE: 'Critical result — lab alerted',
  HUMAN_HOLDS_THREAD: 'Staff handling the conversation',
  LINE_HELD_BY_ANOTHER_RUN: 'Another journey is waiting for a reply',
  TEMPLATE_PAUSED: 'Template unavailable',
  OFFER_EXHAUSTED: 'Offer budget used up',
  FREQUENCY_CAP: 'Already messaged this week',
  QUIET_HOURS: 'Outside sending hours',
  WAITING_ANOTHER_AUTOMATION: 'Waiting its turn',
  UNIT_MISMATCH: 'Result unit changed',
  SEND_FAILED: 'Send failed',
  // The reply vocabulary. Every one of these was reaching the Activity feed and the
  // "Why" filter as a raw SCREAMING_SNAKE code — including the suppressed-visit record,
  // which is a thing the spec asks for by name.
  ASKED: 'Asked, waiting for an answer',
  NO_REPLY: 'Never answered',
  REPLIED: 'Answered',
  HANDED_TO_STAFF: 'Given to a person',
  LINE_BUSY: 'Another journey holds the line',
  SUPPRESSED_ACTIVE_JOURNEY: 'Skipped — already in a journey',
  CAMPAIGN_INACTIVE: 'Offer switched off — no code issued',
  NO_SCHEDULE_ROW: 'No schedule for that branch',
  WHATSAPP_DISABLED: 'WhatsApp switched off',
  ALREADY_SENT_BY_OLD_TICKER: 'Older sender got there first',
};

export const reasonLabel = (code: string) => REASON_LABEL[code] ?? code;

/** Which of the three vocabularies a code belongs to. */
export type Vocab = 'run' | 'outcome';
export const vocabOf = (code: string): Vocab =>
  ['STOPPED_GOAL_MET', 'HELD_OUT', 'PHONE_OPTED_OUT', 'CONVERSION_REVERSED', 'STOPPED_BY_STAFF',
   'SUPPRESSED_ACTIVE_JOURNEY']
    .includes(code) ? 'outcome' : 'run';
