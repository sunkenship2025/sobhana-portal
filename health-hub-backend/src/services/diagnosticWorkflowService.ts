import { DiagnosticWorkflowMode, ReportStatus, VisitStatus } from '@prisma/client';
import prisma from '../lib/prisma';

export const BILL_ONLY_PLACEHOLDER_CODE = '__BILL_ONLY_PLACEHOLDER__';
const BILL_ONLY_PLACEHOLDER_NAME = 'Bill Only Placeholder';

export type DiagnosticNextAction = 'ENTER_RESULTS' | 'CONFIRM_READY' | 'NONE';

type WorkflowOrderLike = {
  workflowMode?: DiagnosticWorkflowMode | null;
};

type ReportVersionLike = {
  status?: ReportStatus | null;
};

export type DiagnosticVisitComposition = {
  hasReportableOrders: boolean;
  hasBillOnlyOrders: boolean;
  hasFinalizedReport: boolean;
  nextAction: DiagnosticNextAction;
};

export function deriveDiagnosticVisitComposition(
  orders: WorkflowOrderLike[],
  visitStatus: VisitStatus | string,
  reportVersions: ReportVersionLike[] = []
): DiagnosticVisitComposition {
  const hasReportableOrders = orders.some(
    (order) => (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) === DiagnosticWorkflowMode.REPORTABLE
  );
  const hasBillOnlyOrders = orders.some(
    (order) => order.workflowMode === DiagnosticWorkflowMode.BILL_ONLY
  );
  const hasFinalizedReport = reportVersions.some(
    (version) => version.status === ReportStatus.FINALIZED
  );

  let nextAction: DiagnosticNextAction = 'NONE';

  if (!hasFinalizedReport) {
    if (hasReportableOrders) {
      nextAction = 'ENTER_RESULTS';
    } else if (hasBillOnlyOrders && visitStatus === VisitStatus.WAITING) {
      nextAction = 'CONFIRM_READY';
    }
  }

  return {
    hasReportableOrders,
    hasBillOnlyOrders,
    hasFinalizedReport,
    nextAction,
  };
}

export function isPureBillOnlyVisit(orders: WorkflowOrderLike[]): boolean {
  const composition = deriveDiagnosticVisitComposition(orders, VisitStatus.WAITING);
  return composition.hasBillOnlyOrders && !composition.hasReportableOrders;
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
