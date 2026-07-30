/**
 * Clinical Panels Routes
 * 
 * Endpoints for panel definition management (report groupings).
 * Panels reference specific TestDefinition versions (pinned).
 * 
 * GET    /api/clinical-panels          — List panels
 * GET    /api/clinical-panels/:id      — Get panel detail
 * POST   /api/clinical-panels          — Create panel
 * PUT    /api/clinical-panels/:id      — Update panel
 * PATCH  /api/clinical-panels/:id      — Toggle active/inactive
 * POST   /api/clinical-panels/:id/preview — Live render preview
 */

import { Router } from 'express';
import { AuditActionType } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';
import { logAction } from '../services/auditService';
import { renderReportHtml } from '../services/reportRendererService';
import { generateMergedReportPdf } from '../services/mergedReportPdfService';
import { buildDraftPanelSnapshot } from '../services/reportSnapshotService';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── Code format validation ───────────────────────────────────────────
const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

// Record a clinical-panel change to the append-only audit log. Best-effort
// (logAction swallows its own errors so it never blocks the response); these
// rows surface in the owner Audit & Anomalies feed as catalog changes.
function auditPanel(
  req: AuthRequest,
  actionType: AuditActionType,
  entityId: string,
  oldValues: any,
  newValues: any,
) {
  return logAction({
    branchId: req.branchId!,
    actionType,
    entityType: 'ClinicalPanel',
    entityId,
    userId: req.user?.id,
    oldValues,
    newValues,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
}

// ─── Helper ──────────────────────────────────────────────────────────
function transformPanel(panel: any) {
  return {
    ...panel,
    // Frontend expects `code` (unique key) + `name` (human label)
    // Schema has `name` (unique key) + `displayName` (human label)
    code: panel.name,                  // unique key → code
    name: panel.displayName || panel.name, // human label → name
    sampleType: panel.sampleType ?? null,
    itemCount: panel.items?.length ?? panel._count?.items ?? 0,
  };
}

function validateLayoutConstraints(layoutType: string, items: any[]): string | null {
  const itemCount = items.length;

  switch (layoutType) {
    case 'TEXT_ONLY':
      if (itemCount !== 1) {
        return 'TEXT_ONLY layout requires exactly 1 test item';
      }
      break;
    case 'IMAGING_NARRATIVE':
      if (itemCount !== 1) {
        return 'IMAGING_NARRATIVE layout requires exactly 1 test item';
      }
      break;
    case 'STANDARD_TABLE':
    case 'PROCEDURE_STRUCTURED':
      if (itemCount < 1) {
        return `${layoutType} layout requires at least 1 test item`;
      }
      break;
    default:
      if (itemCount < 1) {
        return `${layoutType} layout requires at least 1 test item`;
      }
      break;
  }

  return null;
}

/**
 * Panel items must always reference the latest ACTIVE version of a definition.
 * A save may submit a superseded version id (panel stored before the
 * definition was edited) — re-point it to the latest version of its root
 * instead of rejecting, then validate the resolved version is ACTIVE.
 */
async function resolveItemsToLatestActive(
  items: any[]
): Promise<{ items?: any[]; error?: string }> {
  const defIds = items.map((i: any) => i.testDefinitionId);
  const defs = await prisma.testDefinition.findMany({
    where: { id: { in: defIds } },
    select: { id: true, status: true, name: true, rootDefinitionId: true, isLatest: true },
  });

  const byId = new Map(defs.map(d => [d.id, d]));
  const missing = defIds.filter((id: string) => !byId.has(id));
  if (missing.length > 0) {
    return { error: `Test definitions not found: ${missing.join(', ')}` };
  }

  const staleRoots = [...new Set(defs.filter(d => !d.isLatest).map(d => d.rootDefinitionId))];
  const latestByRoot = new Map<string, typeof defs[number]>();
  if (staleRoots.length > 0) {
    const latest = await prisma.testDefinition.findMany({
      where: { rootDefinitionId: { in: staleRoots }, isLatest: true },
      select: { id: true, status: true, name: true, rootDefinitionId: true, isLatest: true },
    });
    for (const d of latest) latestByRoot.set(d.rootDefinitionId, d);
  }

  const resolved: any[] = [];
  const seen = new Set<string>();
  const inactive: string[] = [];
  for (const item of items) {
    const def = byId.get(item.testDefinitionId)!;
    const target = def.isLatest ? def : (latestByRoot.get(def.rootDefinitionId) ?? def);
    if (target.status !== 'ACTIVE') {
      inactive.push(target.name);
      continue;
    }
    // Two stale versions of the same root collapse into one item after re-pointing
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    resolved.push({ ...item, testDefinitionId: target.id });
  }

  if (inactive.length > 0) {
    return { error: `Test definitions not ACTIVE: ${inactive.join(', ')}` };
  }
  return { items: resolved };
}

// ─── GET /check-code — Real-time code uniqueness check ───────────────
router.get('/check-code', async (req: AuthRequest, res) => {
  try {
    const { code } = req.query;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'code query parameter is required' });
    }
    const existing = await prisma.clinicalPanel.findUnique({
      where: { name: code.toUpperCase() },
      select: { id: true },
    });
    return res.json({ available: !existing });
  } catch (error: any) {
    console.error('Error checking code:', error);
    return res.status(500).json({ error: 'CHECK_FAILED', message: error.message });
  }
});

// ─── GET / — List panels ─────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { search, departmentId, layoutType, active } = req.query;

    const where: any = {};

    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (departmentId && typeof departmentId === 'string') {
      where.departmentId = departmentId;
    }

    if (layoutType && typeof layoutType === 'string') {
      where.layoutType = layoutType;
    }

    if (active === 'all') {
      // no filter
    } else if (active === 'false') {
      where.isActive = false;
    } else {
      where.isActive = true;
    }

    const panels = await prisma.clinicalPanel.findMany({
      where,
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: [
        { department: { name: 'asc' } },
        { displayOrder: 'asc' },
        { name: 'asc' },
      ],
    });

    return res.json(panels.map(transformPanel));
  } catch (error: any) {
    console.error('Error listing clinical panels:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── GET /:id — Get panel detail with items ──────────────────────────
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const panel = await prisma.clinicalPanel.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { id: true, name: true } },
        items: {
          include: {
            testDefinition: {
              select: {
                id: true,
                rootDefinitionId: true,
                name: true,
                code: true,
                version: true,
                status: true,
                referenceMin: true,
                referenceMax: true,
                referenceUnit: true,
                referenceText: true,
                method: true,
                sampleType: true,
                interpretationMode: true,
              },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!panel) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    return res.json(transformPanel(panel));
  } catch (error: any) {
    console.error('Error fetching clinical panel:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── POST / — Create panel ───────────────────────────────────────────
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      name, displayName, departmentId, layoutType, sampleType,
      displayOrder, showMethodColumn, showSubgroups, showInterpretation, valueDisplayPrefix, spacedDefinitionsGap,
      summaryInterpretationTemplate, comments, interpretation, subgroupMethods, subgroupTableOverrides,
      panelMethodText, panelMethodItalic, narrativeTemplateHtml, isActive, items,
    } = req.body;

    if (!name || !displayName || !departmentId || !layoutType) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'name, displayName, departmentId, and layoutType are required',
      });
    }

    // Validate code (name) format
    if (!CODE_REGEX.test(name)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Panel code must be 2-20 uppercase alphanumeric characters or underscores (e.g. CBC_PANEL)',
      });
    }

    // Resolve items to the latest ACTIVE definition versions
    let resolvedItems = items;
    if (items?.length) {
      const resolution = await resolveItemsToLatestActive(items);
      if (resolution.error) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: resolution.error });
      }
      resolvedItems = resolution.items;
    }

    // Validate layout type constraints
    const layoutError = validateLayoutConstraints(layoutType, resolvedItems ?? []);
    if (layoutError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: layoutError });
    }

    const panel = await prisma.clinicalPanel.create({
      data: {
        name,
        displayName,
        departmentId,
        layoutType,
        sampleType: sampleType ?? null,
        displayOrder: displayOrder ?? 0,
        showMethodColumn: showMethodColumn ?? false,
        showSubgroups: showSubgroups ?? false,
        showInterpretation: showInterpretation ?? false,
        spacedDefinitionsGap: spacedDefinitionsGap ?? 0,
        valueDisplayPrefix: valueDisplayPrefix || null,
        summaryInterpretationTemplate: summaryInterpretationTemplate ?? null,
        comments: comments ?? null,
        interpretation: interpretation ?? null,
        subgroupMethods: subgroupMethods ?? null,
        subgroupTableOverrides: subgroupTableOverrides ?? null,
        panelMethodText: panelMethodText ?? null,
        panelMethodItalic: panelMethodItalic ?? false,
        narrativeTemplateHtml: narrativeTemplateHtml ?? null,
        items: resolvedItems?.length ? {
          create: resolvedItems.map((item: any, idx: number) => ({
            testDefinitionId: item.testDefinitionId,
            displayOrder: item.displayOrder ?? idx,
            showMethod: item.showMethod ?? false,
            methodText: item.methodText ?? null,
            indentLevel: item.indentLevel ?? 0,
            isBold: item.isBold ?? false,
            isItalic: item.isItalic ?? false,
            subGroup: item.subGroup ?? null,
            joinPrevious: item.joinPrevious ?? false,
            gridWidth: item.gridWidth ?? null,
            displayLabel: item.displayLabel ?? null,
          })),
        } : undefined,
      },
      include: {
        department: { select: { id: true, name: true } },
        items: {
          include: {
            testDefinition: {
              select: { id: true, name: true, code: true, version: true, status: true },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    await auditPanel(req, 'CREATE', panel.id, null, {
      name: panel.name,
      displayName: panel.displayName,
    });
    return res.status(201).json(transformPanel(panel));
  } catch (error: any) {
    console.error('Error creating clinical panel:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'CONFLICT', message: `Panel name "${req.body.name}" already exists` });
    }
    return res.status(500).json({ error: 'CREATE_FAILED', message: error.message });
  }
});

// ─── PUT /:id — Update panel (full replace of items) ─────────────────
router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const {
      name, displayName, departmentId, layoutType, sampleType,
      displayOrder, showMethodColumn, showSubgroups, showInterpretation, valueDisplayPrefix, spacedDefinitionsGap,
      summaryInterpretationTemplate, comments, interpretation, subgroupMethods, subgroupTableOverrides,
      panelMethodText, panelMethodItalic, narrativeTemplateHtml, isActive, items,
    } = req.body;

    const existing = await prisma.clinicalPanel.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          select: { id: true },
        },
      },
    });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    // Resolve items to the latest ACTIVE definition versions
    let resolvedItems = items;
    if (items?.length) {
      const resolution = await resolveItemsToLatestActive(items);
      if (resolution.error) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: resolution.error });
      }
      resolvedItems = resolution.items;
    }

    // Validate layout constraints
    const nextLayoutType = layoutType ?? existing.layoutType;
    const nextItems = resolvedItems ?? existing.items;
    const layoutError = validateLayoutConstraints(nextLayoutType, nextItems);
    if (layoutError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: layoutError });
    }

    console.log("PUT /:id payload spacedDefinitionsGap:", spacedDefinitionsGap);


    const panel = await prisma.$transaction(async (tx) => {
      // Delete existing items and recreate
      if (resolvedItems) {
        await tx.clinicalPanelItem.deleteMany({ where: { panelId: req.params.id } });
      }

      return tx.clinicalPanel.update({
        where: { id: req.params.id },
        data: {
          name: name ?? existing.name,
          displayName: displayName ?? existing.displayName,
          departmentId: departmentId ?? existing.departmentId,
          layoutType: layoutType ?? existing.layoutType,
          sampleType: sampleType !== undefined ? sampleType : existing.sampleType,
          displayOrder: displayOrder ?? existing.displayOrder,
          showMethodColumn: showMethodColumn ?? existing.showMethodColumn,
          showSubgroups: showSubgroups ?? existing.showSubgroups,
          showInterpretation: showInterpretation ?? existing.showInterpretation,
          spacedDefinitionsGap: spacedDefinitionsGap ?? existing.spacedDefinitionsGap,
          valueDisplayPrefix: valueDisplayPrefix !== undefined ? (valueDisplayPrefix || null) : existing.valueDisplayPrefix,
          summaryInterpretationTemplate: summaryInterpretationTemplate !== undefined
            ? summaryInterpretationTemplate
            : existing.summaryInterpretationTemplate,
          comments: comments !== undefined ? comments : existing.comments,
          interpretation: interpretation !== undefined ? interpretation : existing.interpretation,
          subgroupMethods: subgroupMethods !== undefined ? subgroupMethods : existing.subgroupMethods,
          subgroupTableOverrides: subgroupTableOverrides !== undefined ? subgroupTableOverrides : existing.subgroupTableOverrides,
          panelMethodText: panelMethodText !== undefined ? panelMethodText : existing.panelMethodText,
          panelMethodItalic: panelMethodItalic !== undefined ? panelMethodItalic : existing.panelMethodItalic,
          narrativeTemplateHtml: narrativeTemplateHtml !== undefined ? narrativeTemplateHtml : existing.narrativeTemplateHtml,
          isActive: isActive !== undefined ? isActive : existing.isActive,
          items: resolvedItems ? {
            create: resolvedItems.map((item: any, idx: number) => ({
              testDefinitionId: item.testDefinitionId,
              displayOrder: item.displayOrder ?? idx,
              showMethod: item.showMethod ?? false,
              methodText: item.methodText ?? null,
              indentLevel: item.indentLevel ?? 0,
              isBold: item.isBold ?? false,
              isItalic: item.isItalic ?? false,
              subGroup: item.subGroup ?? null,
              joinPrevious: item.joinPrevious ?? false,
              gridWidth: item.gridWidth ?? null,
              displayLabel: item.displayLabel ?? null,
            })),
          } : undefined,
        },
        include: {
          department: { select: { id: true, name: true } },
          items: {
            include: {
              testDefinition: {
                select: { id: true, name: true, code: true, version: true, status: true },
              },
            },
            orderBy: { displayOrder: 'asc' },
          },
        },
      });
    });

    console.log("PUT /:id saved spacedDefinitionsGap:", panel.spacedDefinitionsGap);

    await auditPanel(
      req,
      'UPDATE',
      panel.id,
      { name: existing.name, displayName: existing.displayName },
      { name: panel.name, displayName: panel.displayName },
    );
    return res.json(transformPanel(panel));
  } catch (error: any) {
    console.error('Error updating clinical panel:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'CONFLICT', message: 'Panel name already exists' });
    }
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

// ─── PATCH /:id — Toggle active/inactive ─────────────────────────────
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'isActive (boolean) is required' });
    }

    const panel = await prisma.clinicalPanel.update({
      where: { id: req.params.id },
      data: { isActive },
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });

    await auditPanel(req, 'UPDATE', panel.id, null, {
      name: panel.name,
      displayName: panel.displayName,
      isActive,
    });
    return res.json(transformPanel(panel));
  } catch (error: any) {
    console.error('Error toggling panel:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

// ─── DELETE /:id — Delete panel ──────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.clinicalPanel.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    // Check if referenced by billable products
    const productRefCount = await prisma.billableProductPanel.count({
      where: { panelId: req.params.id },
    });

    if (productRefCount > 0) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Cannot delete: panel is used by ${productRefCount} billable product(s). Remove it from those products first.`,
      });
    }

    // Delete panel items first, then panel
    await prisma.clinicalPanelItem.deleteMany({ where: { panelId: req.params.id } });
    await prisma.clinicalPanel.delete({ where: { id: req.params.id } });

    await auditPanel(
      req,
      'DELETE',
      existing.id,
      { name: existing.name, displayName: existing.displayName },
      null,
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting panel:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: error.message });
  }
});

// Report Builder "type on the report" editor. Appended to the REAL rendered
// report HTML (renderer untouched) ONLY when the builder asks for editable mode.
// Makes the title / panel method / test names / values contenteditable in place
// and posts each committed edit to the parent window. The parent (ReportBuilder)
// maps edits back to config and re-renders on structural change. This keeps ONE
// renderer — the edit surface IS the server's own render, never a client copy.
const REPORT_EDITOR_ASSETS = `
<style id="rb-editor">
  .rb-edit{outline:none;border-radius:2px;transition:background .1s,box-shadow .1s;cursor:text;}
  .rb-edit:hover{background:rgba(43,100,171,.09);box-shadow:0 0 0 3px rgba(43,100,171,.09);}
  .rb-edit:focus{background:#fff;box-shadow:0 0 0 2px #2b64ab;}
  .rb-ph:empty:before{content:attr(data-ph);color:#b3b9c4;font-style:italic;font-weight:400;}
  .results-table tbody td.col-ref,.results-table tbody td.col-result{position:relative;}
  .results-table tbody td.col-ref{cursor:pointer;}
  .rb-rowtools{position:absolute;top:50%;right:2px;transform:translateY(-50%);display:none;gap:3px;white-space:nowrap;z-index:2;}
  .results-table tbody tr.data-row:hover .rb-rowtools{display:inline-flex;}
  .rb-tool{cursor:pointer;font:12px/1 Arial,sans-serif;padding:2px 5px;border-radius:3px;color:#8a93a5;background:#fff;border:1px solid #e2e6ee;user-select:none;}
  .rb-tool:hover{color:#2b64ab;border-color:#2b64ab;}
  .rb-del:hover{color:#c22;border-color:#c22;}
  .rb-drag{cursor:grab;color:#c2c8d0;user-select:none;font:12px/1 Arial;opacity:0;display:inline-block;vertical-align:middle;margin-right:6px;}
  tr.data-row:hover .rb-drag{opacity:1;}
  tr.data-row.rb-dragging{opacity:.4;}
  tr.data-row.rb-over-top>td{box-shadow:inset 0 3px 0 #2b64ab!important;}
  tr.data-row.rb-over-bot>td{box-shadow:inset 0 -3px 0 #2b64ab!important;}
  .rb-addbar{padding:7px 0 2px;display:flex;gap:8px;flex-wrap:wrap;}
  .rb-addbtn{font:600 11px/1 Arial,sans-serif;color:#2b64ab;background:transparent;border:1px dashed rgba(43,100,171,.55);border-radius:20px;padding:6px 14px;cursor:pointer;}
  .rb-addbtn:hover{background:rgba(43,100,171,.08);}
  .rb-addmethod{font:italic 11px/1.4 Arial,sans-serif;color:#2b64ab;cursor:pointer;margin:3px 0;opacity:.75;}
  .rb-addmethod:hover{opacity:1;text-decoration:underline;}
  .rb-kv{font:600 10px/1 Arial;color:#5a6472;background:#fff;border:1px solid #d8dce2;border-radius:20px;padding:3px 9px;margin-left:10px;cursor:pointer;vertical-align:middle;}
  .rb-kv.on{color:#2b64ab;border-color:#2b64ab;background:rgba(43,100,171,.08);}
  .rb-rt-bar{position:fixed;z-index:9999;display:none;gap:2px;background:#1f2430;border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.28);}
  .rb-rt-bar button{font:600 12px/1 Arial;color:#e7eaf0;background:transparent;border:0;border-radius:5px;padding:6px 8px;cursor:pointer;}
  .rb-rt-bar button:hover{background:rgba(255,255,255,.14);}
  .rb-rt-bar .sep{width:1px;background:rgba(255,255,255,.18);margin:2px;}
  .rb-richedit{outline:none;}
  .rb-richedit:hover{box-shadow:0 0 0 3px rgba(43,100,171,.08);border-radius:3px;}
  .rb-richedit:focus{box-shadow:0 0 0 2px #2b64ab;border-radius:3px;background:#fff;}
</style>
<script>
(function(){
  var post=function(m){try{parent.postMessage(Object.assign({__rbEdit:1},m),'*');}catch(e){}};
  var norm=function(s){return (s||'').replace(/\\s+/g,' ').trim();};
  var q=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
  function stripMethod(v){return v.replace(/^method\\s*:\\s*/i,'');}
  function wire(el,commit,ph){
    if(!el||el.__rb)return; el.__rb=1;
    el.setAttribute('contenteditable','true'); el.classList.add('rb-edit');
    if(ph){el.classList.add('rb-ph');el.setAttribute('data-ph',ph);}
    el.addEventListener('mousedown',function(e){e.stopPropagation();});
    el.addEventListener('focus',function(){el.__o=el.textContent;});
    el.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();el.blur();}if(e.key==='Escape'){el.textContent=el.__o||'';el.blur();}});
    el.addEventListener('blur',function(){var v=norm(el.textContent);if(v!==norm(el.__o))commit(v,el);});
  }

  /* ---- shared floating rich-text toolbar for notes / interpretation / narrative ---- */
  var rtbar=null, rtEl=null;
  function ensureBar(){
    if(rtbar)return rtbar;
    rtbar=document.createElement('div'); rtbar.className='rb-rt-bar';
    var mk=function(html,cmd,val,title){ var b=document.createElement('button'); b.innerHTML=html; b.title=title||''; b.addEventListener('mousedown',function(e){e.preventDefault();document.execCommand(cmd,false,val||undefined); if(rtEl){rtEl.__emit&&rtEl.__emit();}}); return b; };
    var sep=function(){var s=document.createElement('span');s.className='sep';return s;};
    rtbar.appendChild(mk('H','formatBlock','H3','Heading'));
    rtbar.appendChild(mk('Body','formatBlock','P','Body'));
    rtbar.appendChild(sep());
    rtbar.appendChild(mk('<b>B</b>','bold','','Bold'));
    rtbar.appendChild(mk('<i>I</i>','italic','','Italic'));
    rtbar.appendChild(mk('<u>U</u>','underline','','Underline'));
    rtbar.appendChild(sep());
    rtbar.appendChild(mk('&bull; List','insertUnorderedList','','Bulleted list'));
    rtbar.appendChild(mk('1. List','insertOrderedList','','Numbered list'));
    document.body.appendChild(rtbar);
    return rtbar;
  }
  function positionBar(el){ var b=ensureBar(); var r=el.getBoundingClientRect(); b.style.display='flex'; b.style.left=Math.max(6,r.left)+'px'; b.style.top=Math.max(6,r.top-40)+'px'; }
  function wireRich(el,field){
    if(!el||el.__rb)return; el.__rb=1;
    el.classList.add('rb-richedit'); el.setAttribute('contenteditable','true');
    el.__emit=function(){ post({type:'panel',field:field,value:el.innerHTML}); };
    el.addEventListener('mousedown',function(e){e.stopPropagation();});
    el.addEventListener('focus',function(){ rtEl=el; positionBar(el); });
    el.addEventListener('input',function(){ el.__emit(); });
    el.addEventListener('blur',function(){ setTimeout(function(){ if(rtbar && document.activeElement!==el && (!rtEl||rtEl===el)){ rtbar.style.display='none'; } },150); });
  }

  /* ---- drag reorder (test rows) ---- */
  var dragIdx=null;
  function bindDrag(tr,idx){
    tr.addEventListener('dragover',function(e){ if(dragIdx==null)return; e.preventDefault(); var rc=tr.getBoundingClientRect(); var before=(e.clientY-rc.top)<rc.height/2; tr.classList.toggle('rb-over-top',before); tr.classList.toggle('rb-over-bot',!before); });
    tr.addEventListener('dragleave',function(){ tr.classList.remove('rb-over-top','rb-over-bot'); });
    tr.addEventListener('drop',function(e){ if(dragIdx==null)return; e.preventDefault(); var before=tr.classList.contains('rb-over-top'); tr.classList.remove('rb-over-top','rb-over-bot'); if(dragIdx!==idx) post({type:'reorder',from:dragIdx,to:idx,before:before}); dragIdx=null; });
  }

  function sectionOf(tr){ var p=tr.previousElementSibling; while(p){ if(p.classList.contains('section-divider'))return p; p=p.previousElementSibling; } return null; }

  try{
    // Report title
    wire(document.querySelector('.panel-title'),function(v){post({type:'panel',field:'label',value:v});},'Report name');
    // Panel method (edit in place, or add when absent)
    var pm=document.querySelector('.panel-method');
    if(pm){ wire(pm,function(v){post({type:'panel',field:'panelMethodText',value:stripMethod(v)});}); }
    else { var tt=document.querySelector('.panel-title'); if(tt){ var addm=document.createElement('div'); addm.className='rb-addmethod'; addm.textContent='+ Add method'; addm.addEventListener('click',function(){ addm.parentNode.removeChild(addm); var d=document.createElement('div'); d.className='panel-method'; d.textContent='Method : '; tt.parentNode.insertBefore(d,tt.nextSibling); wire(d,function(v){post({type:'panel',field:'panelMethodText',value:stripMethod(v)});}); d.focus(); }); tt.parentNode.insertBefore(addm,tt.nextSibling); } }

    // Test names + values, in item order (table + procedure + join-previous grid)
    var names=q('.results-table tbody .test-name, .results-table tbody .grid-cell-label');
    var values=q('.results-table tbody .col-value, .results-table tbody .col-result, .results-table tbody .grid-cell-value');
    names.forEach(function(nm,i){ wire(nm,function(v){post({type:'item',index:i,field:'label',value:v});},'Test name'); });
    values.forEach(function(vc,i){ wire(vc,function(v){post({type:'item',index:i,field:'value',value:v});},'\\u2014'); });

    // Per test row: drag handle + tools + click-to-inspect + ref-cell → ranges
    q('.results-table tbody tr.data-row').forEach(function(tr){
      var nm=tr.querySelector('.test-name, .grid-cell-label'); if(!nm)return; var i=names.indexOf(nm); if(i<0)return;
      var td0=tr.querySelector('td.col-test, td.col-param')||tr.firstElementChild;
      if(td0){ var g=document.createElement('span'); g.className='rb-drag'; g.textContent='\\u283f'; g.title='Drag to reorder'; g.setAttribute('draggable','true'); g.setAttribute('contenteditable','false');
        g.addEventListener('mousedown',function(e){e.stopPropagation();});
        g.addEventListener('dragstart',function(e){ dragIdx=i; tr.classList.add('rb-dragging'); try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(i));}catch(_){} });
        g.addEventListener('dragend',function(){ dragIdx=null; q('.data-row').forEach(function(x){x.classList.remove('rb-dragging','rb-over-top','rb-over-bot');}); });
        td0.insertBefore(g,td0.firstChild); }
      var lastCell=tr.querySelector('td.col-ref, td.col-result')||tr.lastElementChild;
      if(lastCell){ var bar=document.createElement('span'); bar.className='rb-rowtools'; bar.setAttribute('contenteditable','false');
        var insp=document.createElement('span'); insp.className='rb-tool'; insp.textContent='\\u2699'; insp.title='Edit clinical details';
        insp.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();post({type:'inspect',index:i});});
        var del=document.createElement('span'); del.className='rb-tool rb-del'; del.textContent='\\u00d7'; del.title='Remove test';
        del.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();post({type:'delete',index:i});});
        bar.appendChild(insp); bar.appendChild(del); lastCell.appendChild(bar); }
      var ref=tr.querySelector('td.col-ref');
      if(ref){ ref.addEventListener('click',function(e){ if(e.target.closest('[data-rb-edit],.rb-tool,.rb-drag,.rb-edit'))return; post({type:'inspect',index:i,focus:'ranges'}); }); }
      tr.addEventListener('click',function(e){ if(e.target.closest('[data-rb-edit],.rb-tool,.rb-drag,.rb-edit,td.col-ref'))return; post({type:'inspect',index:i}); });
      bindDrag(tr,i);
    });

    // Subgroup dividers: rename + key:value toggle + (add) method
    q('.results-table tbody tr.section-divider').forEach(function(tr){
      var td=tr.querySelector('td'); if(!td)return; var groupName=norm(td.textContent);
      var span=document.createElement('span'); span.textContent=groupName; td.textContent=''; td.appendChild(span);
      wire(span,function(v){ if(v&&v.toUpperCase()!==groupName.toUpperCase()) post({type:'sectionRename',from:groupName,to:v.toUpperCase()}); },'Subgroup name');
      var kv=document.createElement('span'); kv.className='rb-kv'; kv.setAttribute('contenteditable','false'); kv.textContent='key : value'; kv.title='Render this subgroup as a compact key:value smear';
      kv.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();post({type:'sectionKV',name:groupName});}); td.appendChild(kv);
      // method row: edit if present, else offer to add
      var next=tr.nextElementSibling;
      if(next && next.classList.contains('method-row')){ var mtd=next.querySelector('td'); if(mtd){ var ms=document.createElement('span'); ms.textContent=stripMethod(norm(mtd.textContent)); mtd.textContent='Method : '; mtd.appendChild(ms); wire(ms,function(v){post({type:'sectionMethod',name:groupName,value:v});}); } }
      else { var amr=document.createElement('span'); amr.className='rb-kv'; amr.setAttribute('contenteditable','false'); amr.textContent='+ method'; amr.title='Add a method line for this subgroup';
        amr.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();post({type:'sectionMethod',name:groupName,value:'\\u2014'});}); td.appendChild(amr); }
    });

    // Clinical Notes / Interpretation boxes → rich-text editable
    q('.interpretation-block').forEach(function(bl){ var strong=bl.querySelector('strong'); var lab=norm(strong?strong.textContent:''); var field=lab.indexOf('INTERPRET')>=0?'interpretation':'comments'; var body=bl.querySelector('.interpretation-body')||bl.querySelector('p'); if(body) wireRich(body,field); });
    // Narrative / text-only body → rich-text editable (saved as the panel narrative template)
    q('.imaging-narrative, .text-only-result .result-text').forEach(function(el){ wireRich(el,'narrativeTemplateHtml'); });

    // Add affordances
    var tbl=document.querySelector('.results-table');
    if(tbl && tbl.querySelector('tbody')){
      var wrap=document.createElement('div'); wrap.className='rb-addbar';
      var mkAdd=function(txt,fn){ var b=document.createElement('button'); b.type='button'; b.className='rb-addbtn'; b.textContent=txt; b.addEventListener('click',fn); return b; };
      wrap.appendChild(mkAdd('+ Add test',function(){
        var tb=tbl.querySelector('tbody'); var isProc=!!tbl.querySelector('th.col-param');
        var tr=document.createElement('tr'); tr.className='data-row';
        tr.innerHTML=isProc?'<td class="col-param"><div class="test-name rb-edit rb-ph" data-ph="Type test name..." contenteditable="true"></div></td><td class="col-result">\\u2014</td>':'<td class="col-test"><div class="test-name rb-edit rb-ph" data-ph="Type test name..." contenteditable="true"></div></td><td class="col-value">\\u2014</td><td class="col-unit"></td><td class="col-ref"></td>';
        tb.appendChild(tr); var span=tr.querySelector('.test-name'); span.focus();
        span.addEventListener('mousedown',function(e){e.stopPropagation();});
        span.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();span.blur();}});
        var done=false; span.addEventListener('blur',function(){ if(done)return; done=true; var v=norm(span.textContent); if(v){ span.removeAttribute('contenteditable'); span.classList.remove('rb-edit','rb-ph'); span.textContent=v; tr.style.opacity='0.5'; post({type:'create',name:v}); } else if(tr.parentNode){ tr.parentNode.removeChild(tr); } });
      }));
      wrap.appendChild(mkAdd('+ Add subgroup',function(){ post({type:'addSection'}); }));
      if(!document.querySelector('.interpretation-block')){ wrap.appendChild(mkAdd('+ Clinical notes',function(){ post({type:'panel',field:'comments',value:'&nbsp;'}); })); }
      tbl.parentNode.insertBefore(wrap,tbl.nextSibling);
    }

    document.addEventListener('scroll',function(){ if(rtbar&&rtEl&&rtbar.style.display==='flex')positionBar(rtEl); },true);
    var sendReady=function(){post({type:'ready',height:document.documentElement.scrollHeight});};
    sendReady(); window.addEventListener('load',sendReady);
  }catch(e){ post({type:'error',message:String(e&&e.message||e)}); }
})();
</script>`;

export function injectReportEditor(html: string): string {
  return html.includes('</body>')
    ? html.replace(/<\/body>(?![\s\S]*<\/body>)/, `${REPORT_EDITOR_ASSETS}</body>`)
    : html + REPORT_EDITOR_ASSETS;
}

// ─── POST /preview-html — Report Builder live preview ────────────────
// Renders an UNSAVED builder draft (in-progress panel + items + mock patient +
// mock values) through the EXACT same renderer the finalized report uses, so
// the builder preview is byte-identical to production. Stateless / persists
// nothing. profile: 'digital' → screen HTML, 'letterhead' → pdf-physical HTML;
// format: 'pdf' → the real merged digital PDF (byte-exact download preview).
// Registered BEFORE '/:id/preview' — '/preview-html' is a single literal segment
// so it never collides with the '/:id/preview' two-segment route.
router.post('/preview-html', async (req: AuthRequest, res) => {
  try {
    const { panel, items, patient, profile, format, editable } = req.body;
    // Builder-only allowance: a 0-test panel still renders (empty paper — title +
    // empty table + signatures) so the Report Builder can show the report before
    // any test is added. Real report paths are unaffected.
    if (!panel || !Array.isArray(items)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'panel and an items array are required' });
    }

    const branch = await prisma.branch.findUnique({ where: { id: req.branchId! } });
    if (!branch) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Active branch not found' });
    }

    // Real department (READ-ONLY) so signature/lab-incharge resolution and the
    // department header are accurate. Falls back to a placeholder when the
    // builder hasn't picked a department yet.
    const department = panel.departmentId
      ? await prisma.department.findUnique({ where: { id: panel.departmentId } })
      : null;

    const snapshot = await buildDraftPanelSnapshot({
      branch: { id: branch.id, name: branch.name, code: branch.code, address: branch.address, phone: branch.phone },
      department: department
        ? {
            id: department.id,
            name: department.name,
            reportHeaderText: department.reportHeaderText,
            displayOrder: department.displayOrder,
            showLabIncharge: department.showLabIncharge,
          }
        : {
            id: 'draft-dept',
            name: panel.departmentName || 'DEPARTMENT',
            reportHeaderText: panel.departmentName ? `DEPARTMENT OF ${String(panel.departmentName).toUpperCase()}` : 'DEPARTMENT',
            displayOrder: 0,
            showLabIncharge: true,
          },
      panel: {
        code: panel.code ?? panel.name ?? 'PREVIEW',
        label: panel.label ?? panel.displayName ?? panel.name ?? 'Preview',
        layoutType: panel.layoutType ?? 'STANDARD_TABLE',
        sampleType: panel.sampleType ?? null,
        panelMethodText: panel.panelMethodText ?? null,
        panelMethodItalic: panel.panelMethodItalic ?? false,
        showSubgroups: panel.showSubgroups ?? false,
        showInterpretation: panel.showInterpretation ?? false,
        subgroupMethods: panel.subgroupMethods ?? null,
        subgroupTableOverrides: panel.subgroupTableOverrides ?? null,
        valueDisplayPrefix: panel.valueDisplayPrefix ?? null,
        spacedDefinitionsGap: panel.spacedDefinitionsGap ?? 0,
        comments: panel.comments ?? null,
        interpretation: panel.interpretation ?? null,
      },
      items,
      patient,
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Byte-exact digital PDF (only when the builder explicitly opens the PDF tab
    // — never on every keystroke, to keep Puppeteer load off the hot path).
    if (format === 'pdf') {
      const pdf = await generateMergedReportPdf(snapshot, { mode: 'digital', baseUrl, qrDataUrl: '', cache: false });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(pdf);
    }

    // HTML preview. 'letterhead' → the real physical/letterhead profile (header +
    // footer hidden as pre-printed stationery); everything else → the screen
    // profile (identical to the live staff report preview).
    const renderProfile = (profile === 'letterhead' || profile === 'pdf-physical') ? 'pdf-physical' : 'screen';
    const html = renderReportHtml(snapshot, { profile: renderProfile, baseUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(editable ? injectReportEditor(html) : html);
  } catch (error: any) {
    console.error('Error rendering builder preview:', error);
    return res.status(500).json({ error: 'PREVIEW_FAILED', message: error.message });
  }
});

// ─── POST /:id/preview — Live render preview ─────────────────────────
router.post('/:id/preview', async (req: AuthRequest, res) => {
  try {
    // This endpoint returns the panel data structured for the renderer
    // The actual HTML rendering can be done on the frontend or via the report renderer
    const panel = await prisma.clinicalPanel.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { id: true, name: true, reportHeaderText: true } },
        items: {
          include: {
            testDefinition: {
              include: {
                ranges: true,
                interpretationRules: { where: { isActive: true }, orderBy: { displayOrder: 'asc' } },
              },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!panel) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    // Build preview data structure
    const previewData = {
      panel: {
        name: panel.name,
        displayName: panel.displayName,
        layoutType: panel.layoutType,
        showMethodColumn: panel.showMethodColumn,
        summaryInterpretationTemplate: panel.summaryInterpretationTemplate,
        comments: panel.comments,
        interpretation: panel.interpretation,
        panelMethodText: panel.panelMethodText,
        panelMethodItalic: panel.panelMethodItalic,
        narrativeTemplateHtml: panel.narrativeTemplateHtml,
        spacedDefinitionsGap: panel.spacedDefinitionsGap,
      },
      department: panel.department,
      tests: panel.items.map(item => ({
        definitionId: item.testDefinition.id,
        name: item.testDefinition.name,
        code: item.testDefinition.code,
        method: item.showMethod ? (item.methodText ?? item.testDefinition.method) : null,
        referenceMin: item.testDefinition.referenceMin,
        referenceMax: item.testDefinition.referenceMax,
        referenceUnit: item.testDefinition.referenceUnit,
        referenceText: item.testDefinition.referenceText,
        displayOrder: item.displayOrder,
        indentLevel: item.indentLevel,
        isBold: item.isBold,
        isItalic: item.isItalic,
        subGroup: item.subGroup,
        joinPrevious: item.joinPrevious,
        gridWidth: item.gridWidth,
        interpretationMode: item.testDefinition.interpretationMode,
        ranges: item.testDefinition.ranges,
        interpretationRules: item.testDefinition.interpretationRules,
      })),
      // mockResults from request body for preview
      mockResults: req.body.mockResults ?? {},
    };

    return res.json(previewData);
  } catch (error: any) {
    console.error('Error generating panel preview:', error);
    return res.status(500).json({ error: 'PREVIEW_FAILED', message: error.message });
  }
});

export default router;
