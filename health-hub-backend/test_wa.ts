import axios from 'axios';

const WHATSAPP_ACCESS_TOKEN = 'EAAVFqUAZBDS4BQ3iu4iaWPJZAhO3Hn54DuRDxFoWQuGOvfCIZBHPcqpQahSN0ywzEDvtZBZCMYkFgIJb91ZBUONtKIcRZBlc17TXIC8TkYjyN9JlNWmZCU1ZAVOUJCpvbz2GHUnBefaVtu8wAHZAxof4jlrB7h8WtzJiCS0hwV2QSXYKX4J418DuA6GlGAPtx2aQZDZD';
const WHATSAPP_PHONE_NUMBER_ID = '992327867297628';

async function main() {
  const phone = process.argv[2];
  if (!phone) {
    console.error('Usage: npx ts-node test_wa.ts <phone_with_country_code>');
    process.exit(1);
  }

  const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: 'bill_receipt',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'TEST PATIENT' },
            { type: 'text', text: 'D-TEST-123' },
            { type: 'text', text: '₹300.00' }
          ]
        },
        {
          type: 'button',
          sub_type: 'url',
          index: 0,
          parameters: [
            { type: 'text', text: 'test-token-12345' }
          ]
        }
      ]
    }
  };

  try {
    console.log(`Sending WhatsApp template to ${phone}...`);
    const res = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
    });
    console.log('✅ Success! Message ID:', res.data.messages[0].id);
  } catch (err: any) {
    console.error('❌ Failed:', JSON.stringify(err.response?.data || err.message, null, 2));
  }
}

main();
