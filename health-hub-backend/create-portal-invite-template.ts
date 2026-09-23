/**
 * Submit the WhatsApp templates this portal needs, skipping any that exist.
 *
 * It carries NO credentials, deliberately: Meta rejects a utility template that
 * contains them (INCORRECT_CATEGORY), and the authentication category has a fixed
 * body and a 15-character parameter cap that a login email cannot fit. So the
 * template only asks the person to reply; replying opens the 24-hour service
 * window, and the sign-in details follow as free-form text inside it.
 *
 * Submitting sends it to Meta for review under the Sobhana business account.
 * Approval is usually minutes. Until it is APPROVED, Add member still creates the
 * account but the Roles screen will report "Invite not delivered".
 *
 *   npx tsx create-portal-invite-template.ts          # show what would be sent
 *   npx tsx create-portal-invite-template.ts --submit # actually submit it
 */
import 'dotenv/config';
import axios from 'axios';

const PORTAL = (process.env.PUBLIC_PORTAL_BASE_URL || 'https://www.sobhanaportal.com').replace(/\/+$/, '');

const TEMPLATES = [{
  name: 'portal_access_invite',
  category: 'UTILITY',
  language: 'en',
  components: [
    {
      type: 'BODY',
      text:
        'Hi {{1}}, \n\nYou have been given access to the Sobhana Diagnostics portal.\n\n' +
        'Reply to this message and we will send your sign-in details.',
      example: { body_text: [['Anusha']] },
    },
  ],
},
{
  // Prescription ready. Carries NO clinical content — no drug, no dose, no
  // diagnosis. Only the patient's name and the doctor's; the prescription itself
  // lives behind the token. A medicine list sitting in a WhatsApp notification on
  // a lock screen is not something to do to somebody by default.
  //
  // The button's host is the PORTAL, where the SPA renders /rx/:token. The API
  // host serves no SPA, so a link built there 404s.
  name: 'prescription_ready',
  category: 'UTILITY',
  language: 'en',
  components: [
    {
      type: 'BODY',
      text:
        'Hi {{1}},\n\nYour prescription from Dr {{2}} at Sobhana Clinic is ready.\n\n' +
        'You can view and download it using the button below.\n\nPlease take the medicines as advised.',
      example: { body_text: [['Anusha', 'Ramesh Kumar']] },
    },
    {
      type: 'BUTTONS',
      buttons: [
        {
          type: 'URL',
          text: 'View Prescription',
          url: `${PORTAL}/rx/{{1}}`,
          example: [`${PORTAL}/rx/a1b2c3d4e5f6`],
        },
      ],
    },
  ],
}];

async function main() {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WHATSAPP_WABA_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!wabaId || !token) {
    console.error('WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN must be set');
    process.exit(1);
  }
  const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;

  // Already there? Say so rather than submitting a duplicate, which Meta rejects.
  const existing = await axios.get(url, {
    params: { access_token: token, fields: 'name,status,category', limit: 200 },
  });
  const byName = new Map<string, any>((existing.data?.data ?? []).map((t: any) => [t.name, t]));
  const submit = process.argv.includes('--submit');

  for (const tpl of TEMPLATES) {
    const found = byName.get(tpl.name);
    if (found) {
      console.log(`already exists: ${found.name} · ${found.category} · ${found.status}`);
      continue;
    }
    if (!submit) {
      console.log(`would submit ${tpl.name} to ${url}`);
      console.log(JSON.stringify(tpl, null, 2));
      continue;
    }
    const res = await axios.post(url, tpl, { params: { access_token: token } });
    console.log(`submitted ${tpl.name}:`, JSON.stringify(res.data));
  }
  if (!submit) console.log('\nre-run with --submit to send the missing ones to Meta for review');
}

main().catch((e) => {
  console.error('FAILED', JSON.stringify(e?.response?.data ?? e?.message ?? e, null, 2));
  process.exit(1);
});
