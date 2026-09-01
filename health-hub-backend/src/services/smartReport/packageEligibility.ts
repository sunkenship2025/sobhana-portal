/**
 * Is this BillableProduct allowed to have Smart Reports switched on?
 *
 * Bundles only, REPORTABLE only, no EXTERNAL_UPLOAD line anywhere in the tree,
 * and no TEXT_ONLY / IMAGING_NARRATIVE panel. PROCEDURE_STRUCTURED is allowed —
 * despite its neighbours in the enum it is structured, and the per-row bucketing
 * handles it. BILL_ONLY child lines are allowed (they carry no results).
 *
 * Returns the blocking reasons, not just a boolean: the product editor has to
 * tell the owner WHICH line is blocking it.
 */
import prisma from '../../lib/prisma';

export interface PackageCheck {
  eligible: boolean;
  reasons: string[];
  panelIds: string[];
}

const BLOCKING_LAYOUTS = new Set(['TEXT_ONLY', 'IMAGING_NARRATIVE']);

export async function checkPackage(productId: string): Promise<PackageCheck> {
  const reasons: string[] = [];
  const panelIds: string[] = [];

  const root = await prisma.billableProduct.findUnique({
    where: { id: productId },
    select: { id: true, name: true, isBundle: true, workflowMode: true },
  });
  if (!root) return { eligible: false, reasons: ['Product not found'], panelIds };
  if (!root.isBundle) reasons.push('Smart Reports are only available on package bundles');
  if (root.workflowMode !== 'REPORTABLE') {
    reasons.push(`Package workflow is ${root.workflowMode}, which produces no results`);
  }

  // Walk product lines, recursing into child products (depth-guarded).
  const seen = new Set<string>();
  let frontier = [productId];
  for (let depth = 0; depth < 6 && frontier.length; depth += 1) {
    const lines = await prisma.billableProductPanel.findMany({
      where: { productId: { in: frontier } },
      select: {
        panel: { select: { id: true, displayName: true, layoutType: true } },
        childProduct: { select: { id: true, name: true, workflowMode: true } },
      },
    });
    const next: string[] = [];
    for (const l of lines) {
      if (l.panel) {
        panelIds.push(l.panel.id);
        if (BLOCKING_LAYOUTS.has(l.panel.layoutType)) {
          reasons.push(`${l.panel.displayName} is a ${l.panel.layoutType === 'TEXT_ONLY' ? 'text-only' : 'narrative'} panel with no reference ranges`);
        }
      }
      if (l.childProduct && !seen.has(l.childProduct.id)) {
        seen.add(l.childProduct.id);
        if (l.childProduct.workflowMode === 'EXTERNAL_UPLOAD') {
          reasons.push(`${l.childProduct.name} is an uploaded external report with no structured values`);
        } else {
          next.push(l.childProduct.id); // BILL_ONLY children are fine — they carry no results
        }
      }
    }
    frontier = next;
  }

  return { eligible: reasons.length === 0, reasons, panelIds };
}
