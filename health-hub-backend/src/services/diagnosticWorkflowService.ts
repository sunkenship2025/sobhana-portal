import { DiagnosticWorkflowMode, ReportStatus, VisitStatus } from '@prisma/client';
import prisma from '../lib/prisma';

export const BILL_ONLY_PLACEHOLDER_CODE = '__BILL_ONLY_PLACEHOLDER__';
const BILL_ONLY_PLACEHOLDER_NAME = 'Bill Only Placeholder';

export type DiagnosticNextAction = 'ENTER_RESULTS' | 'NONE';

type WorkflowOrderLike = {
  workflowMode?: DiagnosticWorkflowMode | null;
  cancelledAt?: Date | string | null;
  noReportAt?: Date | string | null;
};

type ReportVersionLike = {
  status?: ReportStatus | null;
};

export type DiagnosticVisitComposition = {
  hasReportableOrders: boolean;
  hasBillOnlyOrders: boolean;
  hasExternalUploadOrders: boolean;
  hasFinalizedReport: boolean;
  /** Orders that contribute to the patient-facing report (REPORTABLE or EXTERNAL_UPLOAD). */
  hasReportInclusionOrders: boolean;
  /** Orders that the result-entry screen should land on (REPORTABLE or EXTERNAL_UPLOAD). */
  hasEntryScreenOrders: boolean;
  nextAction: DiagnosticNextAction;
};

export function isReportableOrder(order: WorkflowOrderLike): boolean {
  return (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) === DiagnosticWorkflowMode.REPORTABLE;
}

export function isExternalUploadOrder(order: WorkflowOrderLike): boolean {
  return order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD;
}

export function isBillOnlyOrder(order: WorkflowOrderLike): boolean {
  return order.workflowMode === DiagnosticWorkflowMode.BILL_ONLY;
}

/** Orders included in the patient-facing report (rendered values + appended PDFs). */
export function isReportInclusionOrder(order: WorkflowOrderLike): boolean {
  return isReportableOrder(order) || isExternalUploadOrder(order);
}

/** Orders that surface on the result-entry screen (values to type or files to upload). */
export function isEntryScreenOrder(order: WorkflowOrderLike): boolean {
  return isReportableOrder(order) || isExternalUploadOrder(order);
}

export function deriveDiagnosticVisitComposition(
  orders: WorkflowOrderLike[],
  visitStatus: VisitStatus | string,
  reportVersions: ReportVersionLike[] = []
): DiagnosticVisitComposition {
  // Cancelled orders — and orders closed as "no written report needed" (films
  // only) — no longer participate in the visit's workflow: they shouldn't
  // demand result entry or appear on the report.
  const activeOrders = orders.filter((order) => !order.cancelledAt && !order.noReportAt);
  const hasReportableOrders = activeOrders.some(isReportableOrder);
  const hasBillOnlyOrders = activeOrders.some(isBillOnlyOrder);
  const hasExternalUploadOrders = activeOrders.some(isExternalUploadOrder);
  const hasReportInclusionOrders = hasReportableOrders || hasExternalUploadOrders;
  const hasEntryScreenOrders = hasReportInclusionOrders;
  // A partial release finalizes the current version (v_n) and creates a fresh
  // DRAFT (v_n+1) while leaving visit.status as WAITING — so "any version
  // finalized" no longer implies the visit is done. Gate on visit.status so
  // the next batch's preview/finalize buttons stay visible until the FINAL
  // /finalize call (which is the only path that flips status to COMPLETED).
  const hasFinalizedReport =
    visitStatus === VisitStatus.COMPLETED &&
    reportVersions.some((version) => version.status === ReportStatus.FINALIZED);

  let nextAction: DiagnosticNextAction = 'NONE';

  if (!hasFinalizedReport && hasEntryScreenOrders) {
    nextAction = 'ENTER_RESULTS';
  }

  return {
    hasReportableOrders,
    hasBillOnlyOrders,
    hasExternalUploadOrders,
    hasReportInclusionOrders,
    hasEntryScreenOrders,
    hasFinalizedReport,
    nextAction,
  };
}

/** A visit with only BILL_ONLY orders (no reportable values, no uploads). */
export function isPureBillOnlyVisit(orders: WorkflowOrderLike[]): boolean {
  if (orders.length === 0) return false;
  return orders.every(isBillOnlyOrder);
}

export async function ensureBillOnlyPlaceholderLabTest() {
  const existing = await prisma.labTest.findUnique({
    where: { code: BILL_ONLY_PLACEHOLDER_CODE },
    select: {
      id: true,
      name: true,
      code: true,
      referenceMin: true,
      referenceMax: true,
      referenceUnit: true,
    },
  });

  if (existing) {
    return existing;
  }

  try {
    return await prisma.labTest.create({
      data: {
        name: BILL_ONLY_PLACEHOLDER_NAME,
        code: BILL_ONLY_PLACEHOLDER_CODE,
        priceInPaise: 0,
        isActive: false,
        isPanel: false,
      },
      select: {
        id: true,
        name: true,
        code: true,
        referenceMin: true,
        referenceMax: true,
        referenceUnit: true,
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return prisma.labTest.findUniqueOrThrow({
        where: { code: BILL_ONLY_PLACEHOLDER_CODE },
        select: {
          id: true,
          name: true,
          code: true,
          referenceMin: true,
          referenceMax: true,
          referenceUnit: true,
        },
      });
    }

    throw error;
  }
}
