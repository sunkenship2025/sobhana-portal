/**
 * The medicine list, editable — /api/medications.
 *
 * Until now the 242k-row catalogue could only grow invisibly: a doctor's "write as
 * typed" became a LEARNED row after signing, a correction became an alias, and
 * nobody could see either, fix a typo, or add the brand the clinic stocks. Owner
 * and doctors can now search it, add to it, and edit any medicine.
 *
 * What an edit does and does not reach:
 *   - the resolver and the typeahead read this table directly (no cache), so a
 *     fix, a hide or a delete applies to the very next dictation;
 *   - a SIGNED prescription never changes — it carries its own copy of each line;
 *   - a draft keeps the line text it has until the doctor re-picks it.
 *
 * The controlled-drug flags (schedule, Schedule X, NDPS) decide what may be
 * prescribed by phone or video, so changing them takes a reason. Every change is
 * audited with its before and after.
 */
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { logAction } from '../services/auditService';
import { phoneticKey } from '../services/voiceRx/resolver';

const router = Router();
router.use(authMiddleware);
// The list is org-wide; the branch is only where the audit row is filed.
router.use(branchContextMiddleware);
router.use(requireRole('owner', 'doctor'));

const SELECT = {
  id: true, canonicalName: true, genericName: true, brandName: true, manufacturer: true,
  strength: true, strengthUnit: true, dosageForm: true, route: true, aliases: true,
  scheduleClass: true, isScheduleX: true, isNdps: true,
  source: true, usageCount: true, lastUsedAt: true, isActive: true, createdAt: true,
  learnedBy: { select: { name: true } },
} satisfies Prisma.MedicationSelect;

const TEXT = ['genericName', 'brandName', 'manufacturer', 'strength', 'strengthUnit', 'dosageForm', 'route'] as const;
const CONTROLLED = ['scheduleClass', 'isScheduleX', 'isNdps'] as const;

/** The body, cleaned: trimmed text (blank → null), a de-duplicated alias list. */
function readBody(body: any): { data: Record<string, unknown>; error?: string } {
  const data: Record<string, unknown> = {};
  if (body.canonicalName !== undefined) {
    const n = typeof body.canonicalName === 'string' ? body.canonicalName.trim() : '';
    if (!n) return { data, error: 'The name on the prescription cannot be empty' };
    data.canonicalName = n;
  }
  for (const k of TEXT) {
    if (body[k] !== undefined) data[k] = typeof body[k] === 'string' && body[k].trim() ? body[k].trim() : null;
  }
  if (body.aliases !== undefined) {
    const list: string[] = Array.isArray(body.aliases) ? body.aliases : [];
    const seen = new Set<string>();
    data.aliases = list.map((a) => String(a).trim()).filter((a) => {
      const k = a.toLowerCase();
      if (!a || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 100);
  }
  if (body.scheduleClass !== undefined) data.scheduleClass = typeof body.scheduleClass === 'string' && body.scheduleClass.trim() ? body.scheduleClass.trim() : null;
  if (body.isScheduleX !== undefined) data.isScheduleX = body.isScheduleX === true;
  if (body.isNdps !== undefined) data.isNdps = body.isNdps === true;
  if (body.isActive !== undefined) data.isActive = body.isActive !== false;
  return { data };
}

// ---------------------------------------------------------------------------
// GET /api/medications?q=&offset= — the clinic's own medicines, or a search
//
// No query: what this clinic actually uses — the curated list, what doctors
// added, and anything prescribed — most-used first, hidden ones included so they
// can be turned back on. With a query: all 242k, through the same trigram-indexed
// searchText the resolver uses.
// ---------------------------------------------------------------------------
router.get('/', async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const take = 50;
    const where: Prisma.MedicationWhereInput = q
      ? { deletedAt: null, searchText: { contains: q } }
      : { deletedAt: null, OR: [{ source: { in: ['CURATED', 'LEARNED'] } }, { usageCount: { gt: 0 } }] };
    const rows = await prisma.medication.findMany({
      where,
      orderBy: [{ usageCount: 'desc' }, { canonicalName: 'asc' }],
      skip: offset,
      take: take + 1,
      select: SELECT,
    });
    res.json({ items: rows.slice(0, take), hasMore: rows.length > take });
  } catch (err) {
    logger.error({ err }, 'medications: list failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not load medicines' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/medications — add one the catalogue does not have
// ---------------------------------------------------------------------------
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { data, error } = readBody(req.body ?? {});
    if (error || !data.canonicalName) {
      res.status(400).json({ error: 'BAD_REQUEST', message: error ?? 'The name on the prescription is required' }); return;
    }
    const controlled = data.isScheduleX === true || data.isNdps === true || !!data.scheduleClass;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (controlled && !reason) {
      res.status(400).json({ error: 'REASON_REQUIRED', message: 'Say why this medicine is controlled' }); return;
    }
    const clash = await prisma.medication.findFirst({
      where: { deletedAt: null, canonicalName: { equals: data.canonicalName as string, mode: 'insensitive' } },
      select: { canonicalName: true },
    });
    if (clash) {
      res.status(409).json({ error: 'DUPLICATE', message: `“${clash.canonicalName}” is already in the list — edit that one instead` }); return;
    }

    const created = await prisma.medication.create({
      data: {
        ...(data as Prisma.MedicationCreateInput),
        canonicalName: data.canonicalName as string,
        phoneticKey: phoneticKey(data.canonicalName as string),
        // Added on purpose by someone here: the clinic's own list, ranked with
        // the curated drugs rather than the anonymous import.
        source: 'CURATED',
        learnedBy: { connect: { id: req.user!.id } },
      },
      select: SELECT,
    });
    await logAction({
      actionType: 'CREATE', entityType: 'Medication', entityId: created.id, userId: req.user!.id, branchId: req.branchId!,
      newValues: { ...data, ...(reason ? { reason } : {}) },
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    });
    res.status(201).json(created);
  } catch (err) {
    logger.error({ err }, 'medications: create failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not add the medicine' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/medications/:id — edit any field
// ---------------------------------------------------------------------------
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const before = await prisma.medication.findFirst({ where: { id: req.params.id, deletedAt: null }, select: SELECT });
    if (!before) { res.status(404).json({ error: 'NOT_FOUND', message: 'Medicine not found' }); return; }

    const { data, error } = readBody(req.body ?? {});
    if (error) { res.status(400).json({ error: 'BAD_REQUEST', message: error }); return; }

    const same = (k: string) => JSON.stringify((before as Record<string, unknown>)[k] ?? null) === JSON.stringify(data[k] ?? null);
    const changed = Object.keys(data).filter((k) => !same(k));
    if (changed.length === 0) { res.json(before); return; }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (changed.some((k) => (CONTROLLED as readonly string[]).includes(k)) && !reason) {
      res.status(400).json({ error: 'REASON_REQUIRED', message: 'Changing whether a medicine is controlled needs a reason' }); return;
    }

    const patch: Record<string, unknown> = Object.fromEntries(changed.map((k) => [k, data[k]]));
    if (patch.canonicalName) patch.phoneticKey = phoneticKey(patch.canonicalName as string);
    const after = await prisma.medication.update({ where: { id: before.id }, data: patch, select: SELECT });

    await logAction({
      actionType: 'UPDATE', entityType: 'Medication', entityId: before.id, userId: req.user!.id, branchId: req.branchId!,
      oldValues: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k] ?? null])),
      newValues: { ...Object.fromEntries(changed.map((k) => [k, data[k] ?? null])), ...(reason ? { reason } : {}) },
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    });
    res.json(after);
  } catch (err) {
    logger.error({ err }, 'medications: update failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not save the medicine' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/medications/:id — soft: gone from search and dictation, while
// every prescription that already names it keeps its own copy of the line.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const med = await prisma.medication.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true, canonicalName: true, source: true } });
    if (!med) { res.status(404).json({ error: 'NOT_FOUND', message: 'Medicine not found' }); return; }
    await prisma.medication.update({ where: { id: med.id }, data: { deletedAt: new Date() } });
    await logAction({
      actionType: 'DELETE', entityType: 'Medication', entityId: med.id, userId: req.user!.id, branchId: req.branchId!,
      oldValues: { canonicalName: med.canonicalName, source: med.source },
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'medications: delete failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not delete the medicine' });
  }
});

export default router;
