/**
 * Submit the one WhatsApp template the portal invite needs.
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

const TEMPLATE = {
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
};

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
  const found = (existing.data?.data ?? []).find((t: any) => t.name === TEMPLATE.name);
  if (found) {
    console.log(`already exists: ${found.name} · ${found.category} · ${found.status}`);
    return;
  }

  if (!process.argv.includes('--submit')) {
    console.log('would submit to', url);
    console.log(JSON.stringify(TEMPLATE, null, 2));
    console.log('\nre-run with --submit to send it to Meta for review');
    return;
  }

  const res = await axios.post(url, TEMPLATE, { params: { access_token: token } });
  console.log('submitted:', JSON.stringify(res.data));
}

main().catch((e) => {
  console.error('FAILED', JSON.stringify(e?.response?.data ?? e?.message ?? e, null, 2));
  process.exit(1);
});
