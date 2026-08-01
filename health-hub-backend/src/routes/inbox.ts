/**
 * Inbox Route — Patient Messages (WhatsApp two-way)
 *
 * Read/reply layer over the Conversation + ConversationMessage models that
 * routes/webhooks.ts populates from inbound WhatsApp messages.
 *
 * Mounted at /api/inbox (NOT /api/messages — that base is owned by the existing
 * per-visit send route, whose `GET /:visitId` would otherwise swallow these).
 *
 * Scoping:
 *   - owner            → all branches (optional ?branchId= to narrow)
 *   - staff / incharge → their active branch, PLUS null-branch (unmatched)
 *                        conversations so nothing is ever hidden.
 *
 * The 24-hour customer-service window is enforced HERE (server is the source of
 * truth): free-text replies are rejected once the window has closed; the client
 * countdown is only a hint.
 *
 * Routes:
 *   GET  /conversations                 — list + filter counts
 *   GET  /conversations/:id             — thread + patient context
 *   POST /conversations/:id/reply       — free-text reply (24h window enforced)
 *   POST /conversations/:id/template    — approved-template reply (out of window)
 *   POST /conversations/:id/assign      — claim / release the thread
 *   POST /conversations/:id/read        — mark read (reset unread)
 *   GET  /unread-count                  — total unread (sidebar badge)
 */

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import {
  sendText,
  sendTemplate,
  isWhatsAppEnabled,
  listMessageTemplates,
  TemplateComponent,
} from '../services/whatsappCloudService';
import { resendReportNotification, resendBillNotification } from '../services/notificationService';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);
// Marketing (sales) has no business in patient conversations — hard-block every
// inbox endpoint at the API, not just the nav. Owner is further-gated per-route
// where needed (e.g. setting the default template).
router.use(requireRole('owner', 'lab_incharge', 'staff'));

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 30;
const MAX_THREAD_MESSAGES = 300;

/** Whether the 24h free-text window is currently open for a conversation. */
function isWindowOpen(lastInboundAt: Date | null): boolean {
  if (!lastInboundAt) return false;
  return Date.now() - lastInboundAt.getTime() < DAY_MS;
}

/**
 * Branch scope for the current user, as an array of AND-able where fragments.
 * Owner sees everything (optionally narrowed by ?branchId=); staff see their
 * branch plus unmatched (null-branch) conversations.
 */
function branchScopeFilters(req: AuthRequest): Prisma.ConversationWhereInput[] {
  if (req.user?.role === 'owner') {
    const q = (req.query.branchId as string | undefined)?.trim();
    return q ? [{ OR: [{ branchId: q }, { branchId: null }] }] : [];
  }
  return [{ OR: [{ branchId: req.branchId ?? '__none__' }, { branchId: null }] }];
}

/** Can the current user open this conversation? */
function canAccess(req: AuthRequest, convBranchId: string | null): boolean {
  if (req.user?.role === 'owner') return true;
  return convBranchId === null || convBranchId === req.branchId;
}

type ConvForList = Prisma.ConversationGetPayload<{
  include: {
    patient: { select: { id: true; name: true; patientNumber: true } };
    branch: { select: { id: true; name: true; code: true } };
  };
}>;

function mapConversation(c: ConvForList) {
  return {
    id: c.id,
    phone: c.phone,
    patientId: c.patientId,
    patientName: c.patient?.name ?? null,
    patientNumber: c.patient?.patientNumber ?? null,
    branchId: c.branchId,
    branchName: c.branch?.name ?? null,
    branchCode: c.branch?.code ?? null,
    assignedToId: c.assignedToId,
    status: c.status,
    unreadCount: c.unreadCount,
    lastPreview: c.lastPreview,
    lastMessageAt: c.lastMessageAt,
    lastInboundAt: c.lastInboundAt,
    windowOpen: isWindowOpen(c.lastInboundAt),
    windowExpiresAt: c.lastInboundAt ? new Date(c.lastInboundAt.getTime() + DAY_MS) : null,
  };
}

/** Distinct test names for a visit → "CBP, LFT" (first 3, then "+N"). */
function summarizeTests(
  testOrders: Array<{
    product: { name: string } | null;
    testDefinition: { name: string } | null;
    test: { name: string } | null;
  }>,
): string {
  const names: string[] = [];
  for (const o of testOrders) {
    const n = o.product?.name || o.testDefinition?.name || o.test?.name;
    if (n && !names.includes(n)) names.push(n);
  }
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inbox/conversations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations', async (req: AuthRequest, res) => {
  try {
    const filter = (req.query.filter as string) || 'all'; // all | unread | mine | unlinked
    const search = ((req.query.search as string) || '').trim();
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const userId = req.user?.id;

    const scope = branchScopeFilters(req);

    // AND fragments for the active view (scope + filter + search).
    const and: Prisma.ConversationWhereInput[] = [...scope];
    if (filter === 'unread') and.push({ unreadCount: { gt: 0 } });
    if (filter === 'mine') and.push({ assignedToId: userId });
    if (filter === 'unlinked') and.push({ patientId: null });
    if (search) {
      and.push({
        OR: [
          { phone: { contains: search } },
          { lastPreview: { contains: search, mode: 'insensitive' } },
          { patient: { name: { contains: search, mode: 'insensitive' } } },
          { patient: { patientNumber: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }
    const where: Prisma.ConversationWhereInput = and.length ? { AND: and } : {};

    // Filter-pill counts are scope-only (they ignore the active filter/search).
    const scopeWhere: Prisma.ConversationWhereInput = scope.length ? { AND: scope } : {};

    const [items, total, allCount, unreadCount, mineCount, unlinkedCount] =
      await prisma.$transaction([
        prisma.conversation.findMany({
          where,
          orderBy: { lastMessageAt: 'desc' },
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: {
            patient: { select: { id: true, name: true, patientNumber: true } },
            branch: { select: { id: true, name: true, code: true } },
          },
        }),
        prisma.conversation.count({ where }),
        prisma.conversation.count({ where: scopeWhere }),
        prisma.conversation.count({ where: { AND: [...scope, { unreadCount: { gt: 0 } }] } }),
        prisma.conversation.count({ where: { AND: [...scope, { assignedToId: userId }] } }),
        prisma.conversation.count({ where: { AND: [...scope, { patientId: null }] } }),
      ]);

    res.json({
      conversations: items.map(mapConversation),
      total,
      page,
      pageSize: PAGE_SIZE,
      hasMore: page * PAGE_SIZE < total,
      counts: { all: allCount, unread: unreadCount, mine: mineCount, unlinked: unlinkedCount },
    });
  } catch (err) {
    console.error('[Inbox] list error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load conversations' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inbox/unread-count  (sidebar badge)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/unread-count', async (req: AuthRequest, res) => {
  try {
    const scope = branchScopeFilters(req);
    const count = await prisma.conversation.count({
      where: { AND: [...scope, { unreadCount: { gt: 0 } }] },
    });
    res.json({ count });
  } catch (err) {
    console.error('[Inbox] unread-count error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load unread count' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inbox/templates  (approved templates for out-of-window replies)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/templates', async (_req: AuthRequest, res) => {
  if (!isWhatsAppEnabled()) {
    res.json({ templates: [], enabled: false });
    return;
  }
  try {
    const templates = await listMessageTemplates();
    res.json({ templates, enabled: true });
  } catch (err: any) {
    // Degrade gracefully — the composer falls back to a manual template-name field.
    console.error('[Inbox] templates error:', err?.response?.data || err?.message || err);
    res.json({ templates: [], enabled: true, error: 'Could not load templates (check WHATSAPP_BUSINESS_ACCOUNT_ID / token).' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Default out-of-window template — GET (any role) / POST (OWNER ONLY)
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_TEMPLATE_KEY = 'inbox_default_template';

router.get('/default-template', async (_req: AuthRequest, res) => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: DEFAULT_TEMPLATE_KEY } });
    let parsed: { templateName: string; language: string } | null = null;
    if (row) {
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = null;
      }
    }
    res.json({ default: parsed });
  } catch (err) {
    console.error('[Inbox] get default-template error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load default template' });
  }
});

// Only the owner may choose the default template.
router.post('/default-template', requireRole('owner'), async (req: AuthRequest, res) => {
  try {
    const templateName = ((req.body?.templateName as string) || '').trim();
    const language = ((req.body?.language as string) || 'en').trim();
    if (!templateName) {
      res.status(400).json({ error: 'NO_TEMPLATE', message: 'templateName is required' });
      return;
    }
    const value = JSON.stringify({ templateName, language });
    await prisma.appSetting.upsert({
      where: { key: DEFAULT_TEMPLATE_KEY },
      update: { value },
      create: { key: DEFAULT_TEMPLATE_KEY, value },
    });
    res.json({ ok: true, default: { templateName, language } });
  } catch (err) {
    console.error('[Inbox] set default-template error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to set default template' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/inbox/conversations/:id  (thread + patient context)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const convo = await prisma.conversation.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, name: true, patientNumber: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
    });
    if (!convo) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found' });
      return;
    }
    if (!canAccess(req, convo.branchId)) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Conversation is in another branch' });
      return;
    }

    const messages = await prisma.conversationMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      take: MAX_THREAD_MESSAGES,
    });

    // Patient context rail (best-effort; the linked patient's recent activity).
    let patientContext: any = null;
    if (convo.patientId) {
      const patient = await prisma.patient.findUnique({
        where: { id: convo.patientId },
        select: {
          id: true,
          name: true,
          patientNumber: true,
          gender: true,
          yearOfBirth: true,
          ageUnit: true,
        },
      });
      const visits = await prisma.visit.findMany({
        where: { patientId: convo.patientId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          billNumber: true,
          status: true,
          createdAt: true,
          totalAmountInPaise: true,
          branch: { select: { code: true, name: true } },
          bill: {
            select: {
              totalAmountInPaise: true,
              discountAmountInPaise: true,
              couponDiscountInPaise: true,
              paidAmountInPaise: true,
              paymentStatus: true,
            },
          },
          testOrders: {
            select: {
              product: { select: { name: true } },
              testDefinition: { select: { name: true } },
              test: { select: { name: true } },
            },
          },
        },
      });

      const money = (b: (typeof visits)[number]['bill']) => {
        if (!b) return { netInPaise: 0, dueInPaise: 0, paymentStatus: null as string | null };
        const net =
          b.totalAmountInPaise - b.discountAmountInPaise - b.couponDiscountInPaise;
        const due = Math.max(0, net - b.paidAmountInPaise);
        return { netInPaise: net, dueInPaise: due, paymentStatus: b.paymentStatus };
      };

      const currentYear = new Date().getFullYear();

      // Last report/bill we sent this number — powers the thread "Report sent" system line.
      const lastNotif = await prisma.messageLog.findFirst({
        where: { phone: convo.phone, contextType: { in: ['REPORT', 'BILL'] } },
        orderBy: { createdAt: 'desc' },
        select: { contextType: true, contextId: true, sentAt: true, createdAt: true },
      });
      const notifVisit = lastNotif ? visits.find((v) => v.id === lastNotif.contextId) : undefined;

      patientContext = {
        patient: patient
          ? {
              id: patient.id,
              name: patient.name,
              patientNumber: patient.patientNumber,
              gender: patient.gender,
              age: patient.ageUnit === 'YEARS' ? currentYear - patient.yearOfBirth : null,
            }
          : null,
        latestVisit: visits[0]
          ? {
              id: visits[0].id,
              billNumber: visits[0].billNumber,
              status: visits[0].status,
              createdAt: visits[0].createdAt,
              branchCode: visits[0].branch?.code ?? null,
              tests: summarizeTests(visits[0].testOrders),
              ...money(visits[0].bill),
            }
          : null,
        recentVisits: visits.map((v) => ({
          id: v.id,
          billNumber: v.billNumber,
          status: v.status,
          createdAt: v.createdAt,
          branchCode: v.branch?.code ?? null,
          tests: summarizeTests(v.testOrders),
          ...money(v.bill),
        })),
        lastNotification: lastNotif
          ? {
              type: lastNotif.contextType,
              at: lastNotif.sentAt ?? lastNotif.createdAt,
              tests: notifVisit ? summarizeTests(notifVisit.testOrders) : '',
            }
          : null,
      };
    }

    res.json({
      conversation: mapConversation(convo),
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        messageType: m.messageType,
        mediaUrl: m.mediaUrl,
        isAutoReply: m.isAutoReply,
        staffUserId: m.staffUserId,
        createdAt: m.createdAt,
      })),
      patientContext,
    });
  } catch (err) {
    console.error('[Inbox] thread error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load conversation' });
  }
});

/** Load a conversation and assert the caller may act on it. Returns null + sends
 *  the appropriate error response when not accessible. */
async function loadForAction(req: AuthRequest, res: any) {
  const convo = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!convo) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found' });
    return null;
  }
  if (!canAccess(req, convo.branchId)) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Conversation is in another branch' });
    return null;
  }
  return convo;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inbox/conversations/:id/reply  (free-text — 24h window enforced)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:id/reply', async (req: AuthRequest, res) => {
  try {
    const text = (req.body?.text as string || '').trim();
    if (!text) {
      res.status(400).json({ error: 'EMPTY', message: 'Reply text is required' });
      return;
    }
    if (!isWhatsAppEnabled()) {
      res.status(400).json({ error: 'WA_DISABLED', message: 'WhatsApp messaging is disabled' });
      return;
    }

    const convo = await loadForAction(req, res);
    if (!convo) return;

    // Server-side 24h enforcement — the client countdown is only a hint.
    if (!isWindowOpen(convo.lastInboundAt)) {
      res.status(409).json({
        error: 'WINDOW_CLOSED',
        message:
          'The 24-hour reply window has closed. Send an approved template instead.',
      });
      return;
    }

    const result = await sendText(convo.phone, text);
    const now = new Date();

    await prisma.conversationMessage.create({
      data: {
        conversationId: convo.id,
        direction: 'OUT',
        body: text,
        messageType: 'text',
        staffUserId: req.user?.id ?? null,
        waMessageId: result.waMessageId,
      },
    });

    // Replying implies the staffer has seen the thread → clear unread; claim it
    // for them if it was unassigned.
    await prisma.conversation.update({
      where: { id: convo.id },
      data: {
        lastMessageAt: now,
        lastPreview: text.slice(0, 200),
        unreadCount: 0,
        ...(convo.assignedToId ? {} : { assignedToId: req.user?.id ?? null }),
      },
    });

    res.json({ ok: true, waMessageId: result.waMessageId });
  } catch (err) {
    console.error('[Inbox] reply error:', err);
    res.status(500).json({ error: 'SEND_FAILED', message: 'Failed to send reply' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inbox/conversations/:id/template  (approved template, out of window)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:id/template', async (req: AuthRequest, res) => {
  try {
    const templateName = (req.body?.templateName as string || '').trim();
    const languageCode = (req.body?.languageCode as string || 'en').trim();
    const bodyParams: string[] = Array.isArray(req.body?.bodyParams) ? req.body.bodyParams : [];
    const preview = (req.body?.preview as string || `[Template: ${templateName}]`).trim();

    if (!templateName) {
      res.status(400).json({ error: 'NO_TEMPLATE', message: 'templateName is required' });
      return;
    }
    if (!isWhatsAppEnabled()) {
      res.status(400).json({ error: 'WA_DISABLED', message: 'WhatsApp messaging is disabled' });
      return;
    }

    const convo = await loadForAction(req, res);
    if (!convo) return;

    const components: TemplateComponent[] = bodyParams.length
      ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) }]
      : [];

    const result = await sendTemplate(convo.phone, templateName, components, languageCode);
    const now = new Date();

    await prisma.conversationMessage.create({
      data: {
        conversationId: convo.id,
        direction: 'OUT',
        body: preview,
        messageType: 'template',
        staffUserId: req.user?.id ?? null,
        waMessageId: result.waMessageId,
      },
    });

    await prisma.conversation.update({
      where: { id: convo.id },
      data: {
        lastMessageAt: now,
        lastPreview: preview.slice(0, 200),
        unreadCount: 0,
        ...(convo.assignedToId ? {} : { assignedToId: req.user?.id ?? null }),
      },
    });

    res.json({ ok: true, waMessageId: result.waMessageId });
  } catch (err) {
    console.error('[Inbox] template error:', err);
    res.status(500).json({ error: 'SEND_FAILED', message: 'Failed to send template' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inbox/conversations/:id/assign   { assign: boolean }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:id/assign', async (req: AuthRequest, res) => {
  try {
    const convo = await loadForAction(req, res);
    if (!convo) return;
    const assign = req.body?.assign !== false; // default true (claim)
    const updated = await prisma.conversation.update({
      where: { id: convo.id },
      data: { assignedToId: assign ? req.user?.id ?? null : null },
      select: { id: true, assignedToId: true },
    });
    res.json({ ok: true, assignedToId: updated.assignedToId });
  } catch (err) {
    console.error('[Inbox] assign error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update assignment' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inbox/conversations/:id/read   (reset unread)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:id/read', async (req: AuthRequest, res) => {
  try {
    const convo = await loadForAction(req, res);
    if (!convo) return;
    await prisma.conversation.update({
      where: { id: convo.id },
      data: { unreadCount: 0 },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Inbox] read error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to mark read' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inbox/conversations/:id/send-report  (send the patient's LATEST finalized report)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:id/send-report', async (req: AuthRequest, res) => {
  try {
    if (!isWhatsAppEnabled()) {
      res.status(400).json({ error: 'WA_DISABLED', message: 'WhatsApp messaging is disabled' });
      return;
    }
    const convo = await loadForAction(req, res);
    if (!convo) return;
    if (!convo.patientId) {
      res.status(400).json({ error: 'NO_PATIENT', message: 'No patient linked to this conversation' });
      return;
    }
    // Most recent visit with a finalized report.
    const visit = await prisma.visit.findFirst({
      where: { patientId: convo.patientId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, billNumber: true },
    });
    if (!visit) {
      res.status(400).json({ error: 'NO_REPORT', message: 'No finalized report to send for this patient' });
      return;
    }
    const result = await resendReportNotification(visit.id, req.user?.id);
    if (!result.success) {
      res.status(400).json({ error: 'SEND_FAILED', message: result.error || 'Failed to send report' });
      return;
    }
    const now = new Date();
    await prisma.conversationMessage.create({
      data: {
        conversationId: convo.id,
        direction: 'OUT',
        body: `📄 Report link sent (Bill ${visit.billNumber})`,
        messageType: 'system',
        staffUserId: req.user?.id ?? null,
      },
    });
    await prisma.conversation.update({
      where: { id: convo.id },
      data: { lastMessageAt: now, lastPreview: `Report link sent (${visit.billNumber})`, unreadCount: 0 },
    });
    res.json({ ok: true, billNumber: visit.billNumber });
  } catch (err) {
    console.error('[Inbox] send-report error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to send report' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inbox/conversations/:id/send-bill  (send the patient's LATEST bill)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:id/send-bill', async (req: AuthRequest, res) => {
  try {
    if (!isWhatsAppEnabled()) {
      res.status(400).json({ error: 'WA_DISABLED', message: 'WhatsApp messaging is disabled' });
      return;
    }
    const convo = await loadForAction(req, res);
    if (!convo) return;
    if (!convo.patientId) {
      res.status(400).json({ error: 'NO_PATIENT', message: 'No patient linked to this conversation' });
      return;
    }
    // Most recent visit that has a bill.
    const visit = await prisma.visit.findFirst({
      where: { patientId: convo.patientId, bill: { isNot: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, billNumber: true },
    });
    if (!visit) {
      res.status(400).json({ error: 'NO_BILL', message: 'No bill to send for this patient' });
      return;
    }
    const result = await resendBillNotification(visit.id, req.user?.id);
    if (!result.success) {
      res.status(400).json({ error: 'SEND_FAILED', message: result.error || 'Failed to send bill' });
      return;
    }
    const now = new Date();
    await prisma.conversationMessage.create({
      data: {
        conversationId: convo.id,
        direction: 'OUT',
        body: `🧾 Bill sent (Bill ${visit.billNumber})`,
        messageType: 'system',
        staffUserId: req.user?.id ?? null,
      },
    });
    await prisma.conversation.update({
      where: { id: convo.id },
      data: { lastMessageAt: now, lastPreview: `Bill sent (${visit.billNumber})`, unreadCount: 0 },
    });
    res.json({ ok: true, billNumber: visit.billNumber });
  } catch (err) {
    console.error('[Inbox] send-bill error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to send bill' });
  }
});

export default router;
