import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';

const router = Router();
const prisma = new PrismaClient();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── Helper: transform a LabTest row for API response ───
function transformTest(test: any) {
  return {
    id: test.id,
    name: test.name,
    code: test.code,
    priceInPaise: test.priceInPaise,
    isPanel: test.isPanel,
    isActive: test.isActive,
    displayOrder: test.displayOrder,
    sampleType: test.sampleType,
    method: test.method,
    defaultReferralType: test.defaultReferralType,
    departmentId: test.departmentId,
    parentTestId: test.parentTestId,
    referenceRange: {
      min: test.referenceMin ?? null,
      max: test.referenceMax ?? null,
      unit: test.referenceUnit || '',
      text: test.referenceText || ''
    },
    department: test.department ? { id: test.department.id, name: test.department.name } : null,
    _count: test._count || undefined
  };
}

// ═══════════════════════════════════════════════════════════
//  CORE LAB-TEST CRUD
// ═══════════════════════════════════════════════════════════

// GET /api/lab-tests - List lab tests with filters
router.get('/', async (req: AuthRequest, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const includeSubTests = req.query.includeSubTests === 'true';
    const departmentId = req.query.departmentId as string | undefined;
    const isPanel = req.query.isPanel as string | undefined;
    const sampleType = req.query.sampleType as string | undefined;

    const whereClause: any = {};
    if (!includeInactive) whereClause.isActive = true;
    if (!includeSubTests) whereClause.parentTestId = null;
    if (departmentId) whereClause.departmentId = departmentId;
    if (isPanel !== undefined) whereClause.isPanel = isPanel === 'true';
    if (sampleType) whereClause.sampleType = sampleType;

    const tests = await prisma.labTest.findMany({
      where: whereClause,
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { ageRanges: true, interpretations: true } }
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }]
    });

    return res.json(tests.map(transformTest));
  } catch (err: any) {
    console.error('List lab tests error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list lab tests' });
  }
});

// GET /api/lab-tests/:id - Full detail for a single test
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const test = await prisma.labTest.findUnique({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      include: {
        department: { select: { id: true, name: true } },
        ageRanges: { orderBy: { minAgeDays: 'asc' } },
        derivedParameter: true,
        interpretations: { where: { // @ts-ignore Prisma types
 isActive: true }, orderBy: { displayOrder: 'asc' } },
        panelItems: {
          include: { test: { select: { id: true, name: true, code: true } } },
          orderBy: { displayOrder: 'asc' }
        },
        childTests: {
          where: { // @ts-ignore Prisma types
 isActive: true },
          select: { id: true, name: true, code: true, displayOrder: true },
          orderBy: { displayOrder: 'asc' }
        }
      }
    });

    if (!test) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab test not found' });
    }

    return res.json({
      ...transformTest(test),
      ageRanges: test.ageRanges,
      derivedParameter: test.derivedParameter,
      interpretations: test.interpretations,
      panelItems: test.panelItems,
      childTests: test.childTests
    });
  } catch (err: any) {
    console.error('Get lab test error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get lab test' });
  }
});

// POST /api/lab-tests - Create lab test
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      name, code, price, referenceRange,
      departmentId, sampleType, method, defaultReferralType,
      isPanel, parentTestId, displayOrder
    } = req.body;

    if (!name || !code || price === undefined) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Name, code, and price are required'
      });
    }

    // Duplicate code check
    const existing = await prisma.labTest.findUnique({
      where: { // @ts-ignore Prisma types
 code: code.toUpperCase() }
    });
    if (existing) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Test with code ${code.toUpperCase()} already exists`
      });
    }

    // Validate departmentId if provided
    if (departmentId) {
      const dept = await prisma.department.findUnique({ where: { // @ts-ignore Prisma types
 id: departmentId } });
      if (!dept) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Department not found' });
      }
    }

    const test = await prisma.labTest.create({
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        name,
        code: code.toUpperCase(),
        priceInPaise: Math.round(price * 100),
        referenceMin: referenceRange?.min ?? null,
        referenceMax: referenceRange?.max ?? null,
        referenceUnit: referenceRange?.unit || null,
        referenceText: referenceRange?.text || null,
        departmentId: departmentId || null,
        sampleType: sampleType || null,
        method: method || null,
        defaultReferralType: defaultReferralType || 'SELF',
        isPanel: isPanel || false,
        parentTestId: parentTestId || null,
        displayOrder: displayOrder ?? 0,
        isActive: true
      },
      include: { department: { select: { id: true, name: true } } }
    });

    return res.status(201).json(transformTest(test));
  } catch (err: any) {
    console.error('Create lab test error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create lab test' });
  }
});

// PATCH /api/lab-tests/:id - Update lab test
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const {
      name, code, price, referenceRange,
      departmentId, sampleType, method, defaultReferralType,
      isPanel, parentTestId, displayOrder, isActive
    } = req.body;

    const existing = await prisma.labTest.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab test not found' });
    }

    // Duplicate code check
    if (code && code.toUpperCase() !== existing.code) {
      const duplicate = await prisma.labTest.findUnique({ where: { // @ts-ignore Prisma types
 code: code.toUpperCase() } });
      if (duplicate) {
        return res.status(409).json({
          error: 'CONFLICT',
          message: `Test with code ${code.toUpperCase()} already exists`
        });
      }
    }

    // Validate departmentId if changing
    if (departmentId !== undefined && departmentId !== null) {
      const dept = await prisma.department.findUnique({ where: { // @ts-ignore Prisma types
 id: departmentId } });
      if (!dept) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Department not found' });
      }
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (code !== undefined) updateData.code = code.toUpperCase();
    if (price !== undefined) updateData.priceInPaise = Math.round(price * 100);
    if (referenceRange?.min !== undefined) updateData.referenceMin = referenceRange.min;
    if (referenceRange?.max !== undefined) updateData.referenceMax = referenceRange.max;
    if (referenceRange?.unit !== undefined) updateData.referenceUnit = referenceRange.unit;
    if (referenceRange?.text !== undefined) updateData.referenceText = referenceRange.text;
    if (departmentId !== undefined) updateData.departmentId = departmentId || null;
    if (sampleType !== undefined) updateData.sampleType = sampleType || null;
    if (method !== undefined) updateData.method = method || null;
    if (defaultReferralType !== undefined) updateData.defaultReferralType = defaultReferralType;
    if (isPanel !== undefined) updateData.isPanel = isPanel;
    if (parentTestId !== undefined) updateData.parentTestId = parentTestId || null;
    if (displayOrder !== undefined) updateData.displayOrder = displayOrder;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await prisma.labTest.update({
      where: { // @ts-ignore Prisma types
 id },
      data: // @ts-ignore
updateData,
      include: { department: { select: { id: true, name: true } } }
    });

    return res.json(transformTest(updated));
  } catch (err: any) {
    console.error('Update lab test error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update lab test' });
  }
});

// DELETE /api/lab-tests/:id - Soft-delete (deactivate)
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.labTest.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab test not found' });
    }

    await prisma.labTest.update({ where: { // @ts-ignore Prisma types
 id }, data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 isActive: false } });
    return res.json({ id, message: 'Lab test deactivated' });
  } catch (err: any) {
    console.error('Deactivate lab test error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to deactivate lab test' });
  }
});

// ═══════════════════════════════════════════════════════════
//  AGE-BASED REFERENCE RANGES  /:id/age-ranges
// ═══════════════════════════════════════════════════════════

// GET /api/lab-tests/:id/age-ranges
router.get('/:id/age-ranges', async (req: AuthRequest, res) => {
  try {
    const ranges = await prisma.testAgeRange.findMany({
      where: { // @ts-ignore Prisma types
 testId: req.params.id },
      orderBy: [{ minAgeDays: 'asc' }, { gender: 'asc' }]
    });
    return res.json(ranges);
  } catch (err: any) {
    console.error('List age ranges error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list age ranges' });
  }
});

// POST /api/lab-tests/:id/age-ranges
router.post('/:id/age-ranges', async (req: AuthRequest, res) => {
  try {
    const testId = req.params.id;
    const { minAgeDays, maxAgeDays, gender, referenceMin, referenceMax, referenceUnit, referenceText } = req.body;

    // Verify test exists
    const test = await prisma.labTest.findUnique({ where: { // @ts-ignore Prisma types
 id: testId } });
    if (!test) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab test not found' });
    }

    const range = await prisma.testAgeRange.create({
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        testId,
        minAgeDays: minAgeDays ?? null,
        maxAgeDays: maxAgeDays ?? null,
        gender: gender || null,
        referenceMin: referenceMin ?? null,
        referenceMax: referenceMax ?? null,
        referenceUnit: referenceUnit || null,
        referenceText: referenceText || null
      }
    });
    return res.status(201).json(range);
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'An age range with the same age/gender combination already exists for this test'
      });
    }
    console.error('Create age range error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create age range' });
  }
});

// PATCH /api/lab-tests/:id/age-ranges/:rangeId
router.patch('/:id/age-ranges/:rangeId', async (req: AuthRequest, res) => {
  try {
    const { rangeId } = req.params;
    const { minAgeDays, maxAgeDays, gender, referenceMin, referenceMax, referenceUnit, referenceText } = req.body;

    const existing = await prisma.testAgeRange.findUnique({ where: { // @ts-ignore Prisma types
 id: rangeId } });
    if (!existing || existing.testId !== req.params.id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Age range not found for this test' });
    }

    const updateData: any = {};
    if (minAgeDays !== undefined) updateData.minAgeDays = minAgeDays;
    if (maxAgeDays !== undefined) updateData.maxAgeDays = maxAgeDays;
    if (gender !== undefined) updateData.gender = gender || null;
    if (referenceMin !== undefined) updateData.referenceMin = referenceMin;
    if (referenceMax !== undefined) updateData.referenceMax = referenceMax;
    if (referenceUnit !== undefined) updateData.referenceUnit = referenceUnit;
    if (referenceText !== undefined) updateData.referenceText = referenceText;

    const updated = await prisma.testAgeRange.update({ where: { // @ts-ignore Prisma types
 id: rangeId }, data: // @ts-ignore
updateData });
    return res.json(updated);
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'An age range with the same age/gender combination already exists for this test'
      });
    }
    console.error('Update age range error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update age range' });
  }
});

// DELETE /api/lab-tests/:id/age-ranges/:rangeId
router.delete('/:id/age-ranges/:rangeId', async (req: AuthRequest, res) => {
  try {
    const { rangeId } = req.params;
    const existing = await prisma.testAgeRange.findUnique({ where: { // @ts-ignore Prisma types
 id: rangeId } });
    if (!existing || existing.testId !== req.params.id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Age range not found for this test' });
    }

    await prisma.testAgeRange.delete({ where: { // @ts-ignore Prisma types
 id: rangeId } });
    return res.json({ id: rangeId, message: 'Age range deleted' });
  } catch (err: any) {
    console.error('Delete age range error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete age range' });
  }
});

// ═══════════════════════════════════════════════════════════
//  DERIVED PARAMETER  /:id/derived-parameter
// ═══════════════════════════════════════════════════════════

// GET /api/lab-tests/:id/derived-parameter
router.get('/:id/derived-parameter', async (req: AuthRequest, res) => {
  try {
    const param = await prisma.derivedParameter.findUnique({
      where: { // @ts-ignore Prisma types
 testId: req.params.id }
    });
    if (!param) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No derived parameter for this test' });
    }
    return res.json(param);
  } catch (err: any) {
    console.error('Get derived parameter error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get derived parameter' });
  }
});

// PUT /api/lab-tests/:id/derived-parameter (upsert — one per test)
router.put('/:id/derived-parameter', async (req: AuthRequest, res) => {
  try {
    const testId = req.params.id;
    const { parameterName, formula, dependsOnTestCodes, displayOrder } = req.body;

    if (!parameterName || !formula) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'parameterName and formula are required'
      });
    }

    const test = await prisma.labTest.findUnique({ where: { // @ts-ignore Prisma types
 id: testId } });
    if (!test) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab test not found' });
    }

    const param = await prisma.derivedParameter.upsert({
      where: { // @ts-ignore Prisma types
 testId },
      create: {
        testId,
        parameterName,
        formula,
        dependsOnTestCodes: dependsOnTestCodes || [],
        displayOrder: displayOrder ?? 0
      },
      update: {
        parameterName,
        formula,
        dependsOnTestCodes: dependsOnTestCodes || [],
        displayOrder: displayOrder ?? 0
      }
    });
    return res.json(param);
  } catch (err: any) {
    console.error('Upsert derived parameter error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to save derived parameter' });
  }
});

// DELETE /api/lab-tests/:id/derived-parameter
router.delete('/:id/derived-parameter', async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.derivedParameter.findUnique({ where: { // @ts-ignore Prisma types
 testId: req.params.id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No derived parameter for this test' });
    }

    await prisma.derivedParameter.delete({ where: { // @ts-ignore Prisma types
 testId: req.params.id } });
    return res.json({ testId: req.params.id, message: 'Derived parameter deleted' });
  } catch (err: any) {
    console.error('Delete derived parameter error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete derived parameter' });
  }
});

// ═══════════════════════════════════════════════════════════
//  INTERPRETATION TEMPLATES  /:id/interpretations
// ═══════════════════════════════════════════════════════════

// GET /api/lab-tests/:id/interpretations
router.get('/:id/interpretations', async (req: AuthRequest, res) => {
  try {
    const templates = await prisma.interpretationTemplate.findMany({
      where: { // @ts-ignore Prisma types
 testId: req.params.id, isActive: true },
      orderBy: { displayOrder: 'asc' }
    });
    return res.json(templates);
  } catch (err: any) {
    console.error('List interpretations error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list interpretations' });
  }
});

// POST /api/lab-tests/:id/interpretations
router.post('/:id/interpretations', async (req: AuthRequest, res) => {
  try {
    const testId = req.params.id;
    const { minValue, maxValue, interpretationText, displayOrder } = req.body;

    if (!interpretationText) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'interpretationText is required'
      });
    }

    const test = await prisma.labTest.findUnique({ where: { // @ts-ignore Prisma types
 id: testId } });
    if (!test) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab test not found' });
    }

    const template = await prisma.interpretationTemplate.create({
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        testId,
        minValue: minValue ?? null,
        maxValue: maxValue ?? null,
        interpretationText,
        displayOrder: displayOrder ?? 0,
        isActive: true
      }
    });
    return res.status(201).json(template);
  } catch (err: any) {
    console.error('Create interpretation error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create interpretation' });
  }
});

// PATCH /api/lab-tests/:id/interpretations/:tplId
router.patch('/:id/interpretations/:tplId', async (req: AuthRequest, res) => {
  try {
    const { tplId } = req.params;
    const { minValue, maxValue, interpretationText, displayOrder, isActive } = req.body;

    const existing = await prisma.interpretationTemplate.findUnique({ where: { // @ts-ignore Prisma types
 id: tplId } });
    if (!existing || existing.testId !== req.params.id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Interpretation not found for this test' });
    }

    const updateData: any = {};
    if (minValue !== undefined) updateData.minValue = minValue;
    if (maxValue !== undefined) updateData.maxValue = maxValue;
    if (interpretationText !== undefined) updateData.interpretationText = interpretationText;
    if (displayOrder !== undefined) updateData.displayOrder = displayOrder;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await prisma.interpretationTemplate.update({ where: { // @ts-ignore Prisma types
 id: tplId }, data: // @ts-ignore
updateData });
    return res.json(updated);
  } catch (err: any) {
    console.error('Update interpretation error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update interpretation' });
  }
});

// DELETE /api/lab-tests/:id/interpretations/:tplId — soft-delete
router.delete('/:id/interpretations/:tplId', async (req: AuthRequest, res) => {
  try {
    const { tplId } = req.params;
    const existing = await prisma.interpretationTemplate.findUnique({ where: { // @ts-ignore Prisma types
 id: tplId } });
    if (!existing || existing.testId !== req.params.id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Interpretation not found for this test' });
    }

    await prisma.interpretationTemplate.update({ where: { // @ts-ignore Prisma types
 id: tplId }, data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 isActive: false } });
    return res.json({ id: tplId, message: 'Interpretation template deactivated' });
  } catch (err: any) {
    console.error('Delete interpretation error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to deactivate interpretation' });
  }
});

// ═══════════════════════════════════════════════════════════
//  BULK IMPORT
// ═══════════════════════════════════════════════════════════

// POST /api/lab-tests/bulk-import
// Accepts JSON array of test definitions; all-or-nothing via $transaction
router.post('/bulk-import', async (req: AuthRequest, res) => {
  try {
    const { tests } = req.body;
    if (!Array.isArray(tests) || tests.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Body must contain a non-empty "tests" array' });
    }
    if (tests.length > 500) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Maximum 500 tests per import' });
    }

    // Validate required fields
    const errors: { index: number; message: string }[] = [];
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i];
      if (!t.code || typeof t.code !== 'string') errors.push({ index: i, message: 'Missing or invalid "code"' });
      if (!t.name || typeof t.name !== 'string') errors.push({ index: i, message: 'Missing or invalid "name"' });
      if (!t.departmentId || typeof t.departmentId !== 'string') errors.push({ index: i, message: 'Missing or invalid "departmentId"' });
      if (t.priceInPaise != null && (typeof t.priceInPaise !== 'number' || t.priceInPaise < 0)) {
        errors.push({ index: i, message: '"priceInPaise" must be a non-negative number' });
      }
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Validation failed for some tests', details: errors });
    }

    // Check for duplicate codes within the payload
    const codesInPayload = tests.map((t: any) => t.code.trim().toUpperCase());
    const duplicatePayloadCodes = codesInPayload.filter((c: string, i: number) => codesInPayload.indexOf(c) !== i);
    if (duplicatePayloadCodes.length > 0) {
      return res.status(400).json({
        error: 'DUPLICATE_IN_PAYLOAD',
        message: `Duplicate codes in payload: ${[...new Set(duplicatePayloadCodes)].join(', ')}`
      });
    }

    // Check existing codes in DB
    const existingTests = await prisma.labTest.findMany({
      where: { // @ts-ignore Prisma types
 code: { in: codesInPayload } },
      select: { code: true }
    });
    if (existingTests.length > 0) {
      return res.status(409).json({
        error: 'DUPLICATE_CODE',
        message: `Tests with these codes already exist: ${existingTests.map(t => t.code).join(', ')}`
      });
    }

    // Validate all departmentIds exist
    const deptIds = [...new Set(tests.map((t: any) => t.departmentId))];
    const existingDepts = await prisma.department.findMany({
      where: { // @ts-ignore Prisma types
 id: { in: deptIds as string[] } },
      select: { id: true }
    });
    const existingDeptIds = new Set(existingDepts.map(d => d.id));
    const missingDepts = deptIds.filter(id => !existingDeptIds.has(id as string));
    if (missingDepts.length > 0) {
      return res.status(400).json({
        error: 'INVALID_DEPARTMENT',
        message: `Department IDs not found: ${missingDepts.join(', ')}`
      });
    }

    // All-or-nothing transaction
    const created = await prisma.$transaction(
      tests.map((t: any) =>
        prisma.labTest.create({
          data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

            code: t.code.trim().toUpperCase(),
            name: t.name.trim(),
            departmentId: t.departmentId,
            priceInPaise: t.priceInPaise ?? 0,
            isPanel: t.isPanel ?? false,
            isActive: t.isActive ?? true,
            displayOrder: t.displayOrder ?? 0,
            sampleType: t.sampleType ?? null,
            method: t.method ?? null,
            defaultReferralType: t.defaultReferralType ?? null,
            parentTestId: t.parentTestId ?? null,
            referenceMin: t.referenceMin ?? null,
            referenceMax: t.referenceMax ?? null,
            referenceUnit: t.referenceUnit ?? null,
            referenceText: t.referenceText ?? null,
          },
          include: { department: { select: { id: true, name: true } } }
        })
      )
    );

    return res.status(201).json({
      message: `Successfully imported ${created.length} tests`,
      count: created.length,
      tests: created.map(transformTest)
    });
  } catch (err: any) {
    console.error('Bulk import error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Bulk import failed' });
  }
});

export default router;
