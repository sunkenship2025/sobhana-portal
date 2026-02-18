/**
 * Stock Alert Service (Step 25a)
 * 
 * Sends WhatsApp notifications for low-stock alerts.
 * Called from stockService.ts after stock deduction.
 */

/**
 * Send a WhatsApp low-stock alert. 
 * Non-critical — caller should catch errors.
 */
export async function sendLowStockAlert(
  itemName: string,
  currentQuantity: number,
  unit: string,
  reorderLevel: number
): Promise<void> {
  const enabled = process.env.WHATSAPP_ENABLED === 'true';
  if (!enabled) {
    console.log('[StockAlert] WhatsApp disabled — skipping low-stock alert for', itemName);
    return;
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const adminPhone = process.env.ADMIN_WHATSAPP_PHONE; // e.g. "919876543210"

  if (!phoneNumberId || !accessToken || !adminPhone) {
    console.warn('[StockAlert] WhatsApp config incomplete — skipping alert');
    return;
  }

  try {
    // Send a simple text message (no template required for admin numbers)
    const message = `⚠️ LOW STOCK ALERT\n\n` +
      `Item: ${itemName}\n` +
      `Current: ${currentQuantity} ${unit}\n` +
      `Reorder Level: ${reorderLevel} ${unit}\n\n` +
      `Please restock soon.`;

    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: adminPhone,
        type: 'text',
        text: { body: message },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[StockAlert] WhatsApp API error:', response.status, errorBody);
    } else {
      console.log('[StockAlert] Low-stock alert sent for', itemName);
    }
  } catch (err) {
    console.error('[StockAlert] Failed to send WhatsApp alert:', err);
  }
}
