/**
 * Test Input Config Routes
 *
 * Per-test entry-time UI configuration: input type, default value, preset options.
 * Keyed by rootDefinitionId so config is shared across every version of a test.
 * Lives outside TestDefinition's clone-on-edit / LOCKED rules — these fields
 * never alter stored results or finalized reports.
 *
 * GET    /api/test-input-configs/:rootDefinitionId
 * PUT    /api/test-input-configs/:rootDefinitionId   (upsert)
 * GET    /api/test-input-configs?rootIds=a,b,c       (bulk fetch)
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

const ALLOWED_INPUT_TYPES = ['NUMERIC', 'FREE_TEXT', 'TEXT_WITH_PRESETS', 'SELECT_ONLY'] as const;
type InputType = (typeof ALLOWED_INPUT_TYPES)[number];

function defaultConfig(rootDefinitionId: string) {
  return {
    rootDefinitionId,
    inputType: 'NUMERIC' as InputType,
    defaultValue: null as string | null,
    valueOptions: [] as string[],
  };
}

function sanitizeOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// ─── GET /:rootDefinitionId — fetch one (or default if missing) ──────
router.get('/:rootDefinitionId', async (req: AuthRequest, res) => {
  try {
    const config = await prisma.testInputConfig.findUnique({
      where: { rootDefinitionId: req.params.rootDefinitionId },
    });
    if (!config) {
      return res.json(defaultConfig(req.params.rootDefinitionId));
    }
    return res.json(config);
  } catch (error: any) {
    console.error('Error fetching test input config:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── GET / — bulk fetch by rootIds (comma-separated) ─────────────────
router.get('/', async (req: AuthRequest, res) => {
  try {
    const rootIdsParam = req.query.rootIds;
    if (!rootIdsParam || typeof rootIdsParam !== 'string') {
      return res.json([]);
    }
    const rootIds = rootIdsParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (rootIds.length === 0) return res.json([]);

    const configs = await prisma.testInputConfig.findMany({
      where: { rootDefinitionId: { in: rootIds } },
    });
    return res.json(configs);
  } catch (error: any) {
    console.error('Error bulk-fetching test input configs:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── PUT /:rootDefinitionId — upsert ─────────────────────────────────
router.put('/:rootDefinitionId', async (req: AuthRequest, res) => {
  try {
    const { rootDefinitionId } = req.params;
    const { inputType, defaultValue, valueOptions } = req.body ?? {};

    if (typeof inputType !== 'string' || !ALLOWED_INPUT_TYPES.includes(inputType as InputType)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `inputType must be one of: ${ALLOWED_INPUT_TYPES.join(', ')}`,
      });
    }

    // Verify the rootDefinitionId actually corresponds to a real TestDefinition
    const exists = await prisma.testDefinition.findFirst({
      where: { rootDefinitionId },
      select: { id: true },
    });
    if (!exists) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'No test definition found for this rootDefinitionId',
      });
    }

    const cleanedOptions = sanitizeOptions(valueOptions);
    const cleanedDefault =
      typeof defaultValue === 'string' && defaultValue.trim() ? defaultValue.trim() : null;

    const upserted = await prisma.testInputConfig.upsert({
      where: { rootDefinitionId },
      create: {
        rootDefinitionId,
        inputType: inputType as InputType,
        defaultValue: cleanedDefault,
        valueOptions: cleanedOptions,
      },
      update: {
        inputType: inputType as InputType,
        defaultValue: cleanedDefault,
        valueOptions: cleanedOptions,
      },
    });
    return res.json(upserted);
  } catch (error: any) {
    console.error('Error upserting test input config:', error);
    return res.status(500).json({ error: 'UPSERT_FAILED', message: error.message });
  }
});

export default router;
