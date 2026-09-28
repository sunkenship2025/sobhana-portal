/**
 * The one key for every table automations looks up by phone.
 *
 * TWO FORMS WERE IN USE AND NOTHING RECONCILED THEM. The engine takes a patient's number
 * from PatientIdentifier — ten digits — and held the reply line under it. The WhatsApp
 * webhook reports the sender as twelve, `91` first, and looked the line up under THAT.
 * An exact match between the two can never succeed, so every "Get my code" tap fell
 * through to the inbox and the journey waited out its window as if it had been ignored.
 * The same split wrote a STOP in one form and checked it in the other, and flagged a
 * handed-off thread under a number no thread is filed under.
 *
 * Ten digits, because that is how identifiers are stored — every line the engine has
 * already written is in this form, so nothing needs migrating. Same rule as
 * normalizePhone in patientOtpService, which cannot be imported here without bringing
 * its Redis client with it.
 */
export function phoneKey(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/** The inbox files a thread under the number as WhatsApp reports it: twelve digits, 91 first. */
export function threadPhone(raw: string): string {
  const key = phoneKey(raw);
  return key.length === 10 ? `91${key}` : key;
}
