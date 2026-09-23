/**
 * How a portal login is derived for a newly added team member.
 *
 * Shared by the Roles panel (which mints the account) and the WhatsApp webhook
 * (which mints the password once the invitee replies), so the two cannot drift
 * into generating different shapes for the same person.
 *
 * The shapes here are not a new invention — they describe what the fourteen
 * accounts already in this database look like, so a member added through the UI
 * is indistinguishable from one added by hand: `dileep@sobhana.com` for "Dileep
 * Kumar", and `anusha2@sobhana.com` for the second Anusha.
 */
import { randomInt } from 'crypto';

/**
 * First name, lowercased, letters and digits: "Dileep Kumar" -> "dileep".
 *
 * Digits are KEPT — stripping them silently renames anyone whose first name
 * carries one ("test2" would be handed `test`, which is a different person's
 * login if a "test" already exists). The result must still START with a letter,
 * so a name that is only digits or symbols falls back to "user" rather than
 * minting a numeric login.
 */
export const loginLocalPart = (name: string): string => {
  const first = (name.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^[a-z]/.test(first) ? first : 'user';
};

/**
 * "Dileep@1234".
 *
 * randomInt, not Math.random: this is a credential, and Math.random is neither
 * uniform nor unpredictable. Four digits is deliberately weak on its own, which
 * is why it is delivered over a channel the person controls and is meant to be
 * changed at first sign-in.
 */
export function generatePassword(name: string): string {
  const first = loginLocalPart(name);
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}@${String(randomInt(1000, 10000))}`;
}

/**
 * The domain half of a derived login.
 *
 * Inherited from the login this portal already uses rather than hard-coded, so a
 * rename never leaves the team split across two domains — and never depends on
 * which branch the operator happened to be standing in when they added someone.
 * `existing` must be the EARLIEST account, so the first choice is the one that
 * sticks. The fallback only fires on an empty user table, which cannot happen:
 * this screen is owner-only.
 */
export function loginDomain(existingEmail: string | null | undefined): string {
  return existingEmail?.split('@')[1]?.trim().toLowerCase() || 'sobhana.com';
}

/**
 * The whole address: first name, plus a number if that name is already taken.
 *
 * `existingEmails` must be OLDEST FIRST — the domain is inherited from the first
 * of them. Collisions are resolved on the LOCAL PART across every domain, not on
 * the finished address: an exact-address check would let a second Anusha take
 * `anusha` again on some other domain, giving two people addresses that are
 * unique to Postgres and identical to a human.
 */
export function deriveLogin(name: string, existingEmails: string[]): string {
  const domain = loginDomain(existingEmails[0]);
  const local = loginLocalPart(name);
  const taken = new Set(existingEmails.map((e) => e.split('@')[0]!.toLowerCase()));
  let localPart = local;
  for (let n = 2; taken.has(localPart); n += 1) localPart = `${local}${n}`;
  return `${localPart}@${domain}`;
}

/**
 * The User patch for an activate/deactivate toggle.
 *
 * Deactivating CANCELS a pending invite. The WhatsApp reply handler only matches
 * an ACTIVE member, so an invite left pending on a deactivated account is already
 * dead — it just doesn't look dead. Clearing the flag makes the displayed state
 * match reality; Resend re-issues it.
 */
export const activationPatch = (isActive: boolean): { isActive: boolean; portalInviteAt?: null } =>
  isActive ? { isActive } : { isActive, portalInviteAt: null };
