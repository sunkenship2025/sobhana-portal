/**
 * WhatsApp Cloud API Service
 * 
 * Thin wrapper around Meta's WhatsApp Cloud API (graph.facebook.com/v21.0).
 * Handles template message sending only — no free-form messaging.
 * 
 * Gated by WHATSAPP_ENABLED env var (defaults to false).
 * All failures throw — caller is responsible for error handling and logging.
 * 
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */

import axios from 'axios';

// ============================================================================
// CONFIGURATION
// ============================================================================

const WHATSAPP_API_VERSION = 'v21.0';
const WHATSAPP_API_BASE = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

function getConfig() {
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    // WhatsApp Business Account id — for listing message templates. Existing env
    // name is WHATSAPP_BUSINESS_ACCOUNT_ID; WHATSAPP_WABA_ID kept as a fallback.
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WHATSAPP_WABA_ID || '',
    enabled: process.env.WHATSAPP_ENABLED === 'true',
  };
}

// ============================================================================
// TYPES
// ============================================================================

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'url' | 'quick_reply';
  index?: number;
  parameters: TemplateParameter[];
}

export interface TemplateParameter {
  type: 'text' | 'document' | 'image';
  text?: string;
  document?: { link: string; filename: string };
  image?: { link: string };
}

export interface SendTemplateResult {
  waMessageId: string;
  success: boolean;
}

// ============================================================================
// CORE API
// ============================================================================

/**
 * Send a WhatsApp template message to a phone number.
 * 
 * @param phone - Phone number in international format (e.g., "919876543210")
 * @param templateName - HSM template name approved by Meta (e.g., "lab_report_ready")
 * @param components - Template variable components (header, body, button params)
 * @param languageCode - Template language (default: "en")
 * @returns waMessageId for tracking delivery status
 * @throws Error if WHATSAPP_ENABLED is false or API call fails
 */
export async function sendTemplate(
  phone: string,
  templateName: string,
  components: TemplateComponent[] = [],
  languageCode: string = 'en',
): Promise<SendTemplateResult> {
  const config = getConfig();

  if (!config.enabled) {
    throw new Error('WhatsApp messaging is disabled (WHATSAPP_ENABLED != true)');
  }

  if (!config.phoneNumberId || !config.accessToken) {
    throw new Error('WhatsApp Cloud API credentials not configured');
  }

  // Normalize phone: strip leading + if present, ensure starts with country code
  const normalizedPhone = phone.replace(/^\+/, '').replace(/\s/g, '');

  const payload: any = {
    messaging_product: 'whatsapp',
    to: normalizedPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };

  // Only include components if there are any
  if (components.length > 0) {
    payload.template.components = components;
  }

  const response = await axios.post(
    `${WHATSAPP_API_BASE}/${config.phoneNumberId}/messages`,
    payload,
    {
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000, // 10s timeout
    },
  );

  // Meta returns: { messaging_product: "whatsapp", contacts: [...], messages: [{ id: "wamid.xxx" }] }
  const waMessageId = response.data?.messages?.[0]?.id;

  if (!waMessageId) {
    throw new Error(`WhatsApp API returned no message ID. Response: ${JSON.stringify(response.data)}`);
  }

  return {
    waMessageId,
    success: true,
  };
}

/**
 * Send a free-form text message. ONLY valid inside the 24h customer-service
 * window (i.e. after the user messages us). Used for campaign auto-replies.
 */
export async function sendText(phone: string, text: string): Promise<SendTemplateResult> {
  const config = getConfig();
  if (!config.enabled) throw new Error('WhatsApp messaging is disabled (WHATSAPP_ENABLED != true)');
  if (!config.phoneNumberId || !config.accessToken) throw new Error('WhatsApp Cloud API credentials not configured');

  const normalizedPhone = phone.replace(/^\+/, '').replace(/\s/g, '');
  const response = await axios.post(
    `${WHATSAPP_API_BASE}/${config.phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to: normalizedPhone, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 },
  );
  const waMessageId = response.data?.messages?.[0]?.id;
  if (!waMessageId) throw new Error(`WhatsApp API returned no message ID. Response: ${JSON.stringify(response.data)}`);
  return { waMessageId, success: true };
}

/**
 * Check if WhatsApp messaging is enabled.
 * Use this to gate UI buttons and skip notification calls.
 */
export function isWhatsAppEnabled(): boolean {
  return getConfig().enabled;
}

/**
 * Format an Indian phone number for WhatsApp API.
 * Accepts: "9876543210", "09876543210", "+919876543210", "919876543210"
 * Returns: "919876543210" (no + prefix, with country code)
 */
export function formatPhoneForWhatsApp(phone: string): string {
  const cleaned = phone.replace(/[\s\-\+\(\)]/g, '');

  // Already has country code
  if (cleaned.startsWith('91') && cleaned.length === 12) {
    return cleaned;
  }

  // Strip leading 0 if present
  const withoutLeadingZero = cleaned.startsWith('0') ? cleaned.slice(1) : cleaned;

  // Add country code if 10 digits
  if (withoutLeadingZero.length === 10) {
    return `91${withoutLeadingZero}`;
  }

  // Return as-is if we can't normalize
  return cleaned;
}

// ============================================================================
// MESSAGE TEMPLATES (for the out-of-window reply picker)
// ============================================================================

export interface MessageTemplateSummary {
  name: string;
  language: string;
  category: string; // UTILITY | MARKETING | AUTHENTICATION
  status: string; // APPROVED (we only surface these)
  bodyText: string; // raw body, may contain {{1}} placeholders
  paramCount: number; // number of {{n}} placeholders in the body
  hasHeaderMedia: boolean; // header needs an image/video/document — not fillable from the picker
}

let templateCache: { at: number; data: MessageTemplateSummary[] } | null = null;
const TEMPLATE_CACHE_MS = 5 * 60 * 1000;

/**
 * List APPROVED message templates for the WABA. Cached in-memory for 5 min
 * (Meta rate-limits this endpoint). Requires WHATSAPP_WABA_ID.
 */
export async function listMessageTemplates(force = false): Promise<MessageTemplateSummary[]> {
  const config = getConfig();
  if (!config.wabaId || !config.accessToken) {
    throw new Error('WhatsApp WABA id / access token not configured (set WHATSAPP_BUSINESS_ACCOUNT_ID)');
  }
  if (!force && templateCache && Date.now() - templateCache.at < TEMPLATE_CACHE_MS) {
    return templateCache.data;
  }

  const response = await axios.get(`${WHATSAPP_API_BASE}/${config.wabaId}/message_templates`, {
    params: { fields: 'name,status,category,language,components', limit: 200 },
    headers: { Authorization: `Bearer ${config.accessToken}` },
    timeout: 10000,
  });

  const raw: any[] = response.data?.data ?? [];
  const parsed: MessageTemplateSummary[] = raw
    .filter((t) => t.status === 'APPROVED')
    .map((t) => {
      const components: any[] = t.components || [];
      const body = components.find((c) => c.type === 'BODY');
      const header = components.find((c) => c.type === 'HEADER');
      const bodyText: string = body?.text || '';
      const paramCount = (bodyText.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
      const hasHeaderMedia =
        !!header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(header.format || '').toUpperCase());
      return {
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        bodyText,
        paramCount,
        hasHeaderMedia,
      };
    });

  templateCache = { at: Date.now(), data: parsed };
  return parsed;
}
