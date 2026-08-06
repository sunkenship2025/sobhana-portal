import { Prisma, VisitStatus } from "@prisma/client";
import { Router } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { branchContextMiddleware } from "../middleware/branch";
import prisma from "../lib/prisma";
import { searchWorklist } from "../lib/worklistSearch";
import { emitBranchChange } from "../lib/displayEvents";
import {
  getWorklistIndex,
  setWorklistIndex,
} from "../lib/worklistIndexCache";
import { logAction } from "../services/auditService";
import {
  generateClinicBillNumber,
  generateOpTokenNumber,
} from "../services/numberService";
import {
  DUPLICATE_VISIT_WINDOW_MS,
  DuplicateVisitError,
  duplicateVisitLockId,
} from "../lib/duplicateGuard";
import { getPatientAge, getPatientAgeDisplay } from "../utils/validation";

const router = Router();

const REVISIT_WINDOW_DAYS = 7;

type RevisitDecision = "AUTO" | "FORCE_REVISIT" | "FORCE_NORMAL";
type RevisitMode = "VISIT" | "REVISIT";
type PrismaLikeClient = typeof prisma | Prisma.TransactionClient;

type ClinicVisitRecord = Prisma.VisitGetPayload<{
  include: {
    patient: {
      include: {
        identifiers: true;
      };
    };
    clinicVisit: {
      include: {
        clinicDoctor: true;
      };
    };
    bill: {
      include: {
        transactions: true;
      };
    };
  };
}>;

type RevisitAnchorRecord = Prisma.VisitGetPayload<{
  include: {
    bill: true;
    clinicVisit: {
      include: {
        clinicDoctor: true;
      };
    };
  };
}>;

type OriginalVisitRecord = Prisma.VisitGetPayload<{
  select: {
    id: true;
    billNumber: true;
    createdAt: true;
    bill: {
      select: {
        billNumber: true;
        billedAt: true;
        createdAt: true;
      };
    };
  };
}>;

type OriginalVisitSummary = {
  id: string;
  visitRef: string;
  billNumber: string | null;
  createdAt: Date;
  billedAt: Date | null;
};

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

function createHttpError(statusCode: number, error: string, message: string) {
  const err = new Error(message) as Error & {
    statusCode: number;
    error: string;
  };
  err.statusCode = statusCode;
  err.error = error;
  return err;
}

function subtractDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() - days);
  return next;
}

function getVisitReferenceDate(visit: {
  createdAt: Date;
  bill?: {
    billedAt?: Date | null;
    createdAt?: Date | null;
  } | null;
}) {
  return visit.bill?.billedAt || visit.bill?.createdAt || visit.createdAt;
}

function isWithinRevisitWindow(referenceDate: Date, now = new Date()) {
  return (
    referenceDate.getTime() >= subtractDays(now, REVISIT_WINDOW_DAYS).getTime()
  );
}

function normalizeRevisitDecision(value: unknown): RevisitDecision {
  if (value === "FORCE_REVISIT" || value === "FORCE_NORMAL") {
    return value;
  }
  return "AUTO";
}

function toOriginalVisitSummary(
  visit: OriginalVisitRecord,
): OriginalVisitSummary {
  return {
    id: visit.id,
    visitRef: visit.billNumber,
    billNumber: visit.bill?.billNumber || null,
    createdAt: visit.createdAt,
    billedAt: visit.bill?.billedAt || visit.bill?.createdAt || null,
  };
}

async function loadOriginalVisitMap(
  client: PrismaLikeClient,
  originalVisitIds: Array<string | null | undefined>,
) {
  const uniqueIds = Array.from(
    new Set(
      originalVisitIds.filter((visitId): visitId is string => Boolean(visitId)),
    ),
  );

  if (uniqueIds.length === 0) {
    return new Map<string, OriginalVisitSummary>();
  }

  const originalVisits = await client.visit.findMany({
    where: { id: { in: uniqueIds } },
    select: {
      id: true,
      billNumber: true,
      createdAt: true,
      bill: {
        select: {
          billNumber: true,
          billedAt: true,
          createdAt: true,
        },
      },
    },
  });

  return new Map(
    originalVisits.map((visit) => [visit.id, toOriginalVisitSummary(visit)]),
  );
}

async function findLatestRevisitAnchor(
  client: PrismaLikeClient,
  params: {
    branchId: string;
    patientId: string;
    doctorId: string;
  },
) {
  return client.visit.findFirst({
    where: {
      branchId: params.branchId,
      patientId: params.patientId,
      domain: "CLINIC",
      status: "COMPLETED",
      clinicVisit: {
        clinicDoctorId: params.doctorId,
        isRevisit: false,
      },
      bill: {
        paymentStatus: "PAID",
      },
    },
    include: {
      bill: { include: { transactions: true } },
      clinicVisit: {
        include: {
          clinicDoctor: true,
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
  });
}

function buildRevisitContext(anchorVisit: RevisitAnchorRecord | null) {
  if (!anchorVisit) {
    return {
      defaultMode: "VISIT" as RevisitMode,
      eligible: false,
      canForceRevisit: false,
      canForceNormal: false,
      anchorVisit: null,
    };
  }

  const referenceDate = getVisitReferenceDate(anchorVisit);
  const eligible = isWithinRevisitWindow(referenceDate);

  return {
    defaultMode: eligible
      ? ("REVISIT" as RevisitMode)
      : ("VISIT" as RevisitMode),
    eligible,
    canForceRevisit: true,
    canForceNormal: eligible,
    anchorVisit: {
      id: anchorVisit.id,
      visitRef: anchorVisit.billNumber,
      originalBillNumber: anchorVisit.bill?.billNumber || null,
      visitDate: anchorVisit.createdAt,
      billedAt:
        anchorVisit.bill?.billedAt || anchorVisit.bill?.createdAt || null,
      doctorName: anchorVisit.clinicVisit?.clinicDoctor?.name || null,
    },
  };
}

async function resolveRevisitSelection(
  client: PrismaLikeClient,
  params: {
    branchId: string;
    patientId: string;
    doctorId: string;
    revisitDecision: RevisitDecision;
  },
) {
  const anchorVisit = await findLatestRevisitAnchor(client, params);
  const revisitContext = buildRevisitContext(anchorVisit);

  let revisitMode = revisitContext.defaultMode;

  if (params.revisitDecision === "FORCE_REVISIT") {
    if (!anchorVisit || !revisitContext.canForceRevisit) {
      throw createHttpError(
        400,
        "VALIDATION_ERROR",
        "Revisit can only be used when a prior paid clinic consultation exists",
      );
    }
    revisitMode = "REVISIT";
  }

  if (params.revisitDecision === "FORCE_NORMAL") {
    revisitMode = "VISIT";
  }

  return {
    revisitContext,
    anchorVisit,
    revisitMode,
    isRevisit: revisitMode === "REVISIT",
  };
}

function transformClinicVisit(
  visit: ClinicVisitRecord,
  originalVisitMap = new Map<string, OriginalVisitSummary>(),
) {
  const originalVisit = visit.clinicVisit?.originalVisitId
    ? originalVisitMap.get(visit.clinicVisit.originalVisitId) || null
    : null;

  return {
    id: visit.id,
    branchId: visit.branchId,
    visitRef: visit.billNumber,
    billNumber: visit.bill?.billNumber || null,
    hasBill: Boolean(visit.bill),
    patientId: visit.patientId,
    patient: {
      ...visit.patient,
      age: getPatientAge(visit.patient.dateOfBirth, visit.patient.yearOfBirth),
      ageUnit: visit.patient.ageUnit || "YEARS",
      ageDisplay: getPatientAgeDisplay(
        visit.patient.dateOfBirth,
        visit.patient.yearOfBirth,
        visit.patient.ageUnit,
      ),
    },
    domain: visit.domain,
    status: visit.clinicVisit?.status || visit.status,
    visitType: visit.clinicVisit?.visitType || "OP",
    tokenNumber: visit.clinicVisit?.tokenNumber ?? null,
    hospitalWard: visit.clinicVisit?.hospitalWard || null,
    doctorId: visit.clinicVisit?.clinicDoctorId || null,
    doctor: visit.clinicVisit?.clinicDoctor || null,
    totalAmount: visit.totalAmountInPaise / 100,
    consultationFee: (visit.clinicVisit?.consultationFeeInPaise || 0) / 100,
    isRevisit: visit.clinicVisit?.isRevisit || false,
    originalVisitId: visit.clinicVisit?.originalVisitId || null,
    originalVisitVisitRef: originalVisit?.visitRef || null,
    originalVisitBillNumber: originalVisit?.billNumber || null,
    originalVisitDate: originalVisit?.createdAt || null,
    paymentType:
      Array.isArray((visit as any).bill?.transactions) && (visit as any).bill.transactions.length > 0 ? Array.from(new Set((visit as any).bill.transactions.map((t: any) => t.paymentType))).join(', ') : null,
    paymentStatus: visit.bill?.paymentStatus || null,
    billedAt: visit.bill?.billedAt || visit.bill?.createdAt || null,
    startedAt: visit.clinicVisit?.startedAt || null,
    completedAt: visit.clinicVisit?.completedAt || null,
    createdAt: visit.createdAt,
    updatedAt: visit.updatedAt,
  };
}

// Finalized OP/IP worklist paginates server-side, same two-phase design as
// diagnosticVisits.ts: a LIGHT scan builds the ordered candidate IDs (cached
// ~45s per filter combo), then only the page's ≤20 rows are hydrated heavy.
// Clinic has no report composition — inclusion is just "COMPLETED" (already in
// the where), so the index only applies the visit-type / doctor / search
// filters and the completed-time sort.
const COMPLETED_INDEX_SCAN_CAP = 2000;

async function computeCompletedClinicIndex(
  branchId: string,
  from: string | undefined,
  to: string | undefined,
  visitType: string | undefined,
  doctorId: string | undefined,
  q: string,
): Promise<{ ids: string[]; total: number }> {
  const qNorm = q.trim().toLowerCase();
  const typeKey = visitType && visitType !== "all" ? visitType : "all";
  const cacheKey = `clinic|${branchId}|${from ?? "90d"}|${to ?? ""}|${typeKey}|${doctorId ?? ""}|${qNorm}`;
  const cached = getWorklistIndex(cacheKey);
  if (cached) return cached;

  const fromDate = from
    ? new Date(`${from}T00:00:00`)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const where: any = {
    domain: "CLINIC",
    branchId,
    clinicVisit: { status: "COMPLETED" },
  };
  // updatedAt scan is a cheap lower-bound superset (advances on reprint/resend);
  // the real window is enforced on the stable completedAt date below.
  if (!isNaN(fromDate.getTime())) where.updatedAt = { gte: fromDate };

  // Visible-set window on the row's STABLE completed date (the same date the row
  // shows and sorts by) so an OP/IP visit completed earlier but re-touched today
  // can't leak into "Today". Only when `from` is explicit; "all"/90d keeps the
  // recently-active superset.
  const stableFromMs = from ? fromDate.getTime() : null;
  const stableToMs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;

  const light = await prisma.visit.findMany({
    where,
    take: COMPLETED_INDEX_SCAN_CAP,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      billNumber: true,
      updatedAt: true,
      bill: { select: { billNumber: true } },
      clinicVisit: {
        select: { completedAt: true, visitType: true, clinicDoctorId: true },
      },
      patient: {
        select: { name: true, identifiers: { select: { type: true, value: true } } },
      },
    },
  });

  if (light.length >= COMPLETED_INDEX_SCAN_CAP) {
    console.warn(
      `[worklist] clinic COMPLETED index hit scan cap (${COMPLETED_INDEX_SCAN_CAP}) for branch ${branchId}; oldest in-window rows may be omitted — narrow the date range or raise the cap.`,
    );
  }

  const rows = light.map((v) => {
    const completedAt = v.clinicVisit?.completedAt ?? v.updatedAt;
    return {
      id: v.id,
      visitType: v.clinicVisit?.visitType ?? "OP",
      doctorId: v.clinicVisit?.clinicDoctorId ?? null,
      sortMs: completedAt ? new Date(completedAt).getTime() : 0,
      name: v.patient?.name ?? null,
      phone:
        v.patient?.identifiers?.find((i) => i.type === "PHONE")?.value ?? null,
      billNumber: v.bill?.billNumber ?? null,
      visitRef: v.billNumber ?? null,
    };
  });

  let ordered = rows.filter(
    (r) =>
      (typeKey === "all" || r.visitType === typeKey) &&
      (!doctorId || r.doctorId === doctorId) &&
      (stableFromMs == null || r.sortMs >= stableFromMs) &&
      (stableToMs == null || r.sortMs <= stableToMs),
  );
  ordered.sort((a, b) => b.sortMs - a.sortMs);
  if (qNorm) {
    ordered = searchWorklist(ordered, q, (r) => ({
      name: r.name,
      phone: r.phone,
      billNumber: r.billNumber,
      visitRef: r.visitRef,
    }));
  }

  const ids = ordered.map((r) => r.id);
  setWorklistIndex(cacheKey, ids, ids.length);
  return { ids, total: ids.length };
}

// GET /api/visits/clinic - List clinic visits
// When patientId is provided: Returns ALL visits for that patient across ALL branches (Patient 360 view)
// When patientId is omitted: Returns visits for current branch only (daily operations)
router.get("/", async (req: AuthRequest, res) => {
  try {
    const { status, doctorId, patientId, from, to, visitType, q, page, pageSize } = req.query;

    const where: any = {
      domain: "CLINIC",
    };

    if (patientId) {
      where.patientId = patientId;
    } else {
      where.branchId = req.branchId;
    }

    if (status) {
      // Comma-separated list support (e.g. "WAITING,IN_PROGRESS" for the live
      // queue) so a caller never has to fetch every status just to combine two.
      const statusList = String(status).split(",").map((s) => s.trim()).filter(Boolean);
      where.clinicVisit = statusList.length > 1 ? { status: { in: statusList } } : { status: statusList[0] };
    }

    // Finalized OP/IP worklist: compute (or reuse a cached) ordered ID index
    // for the whole filtered set, then narrow the heavy fetch to this page's
    // ≤20 IDs. The live queue (WAITING,IN_PROGRESS) and Patient 360 keep the
    // plain full-array behavior.
    let paginated:
      | { total: number; page: number; pageSize: number; totalPages: number; order: string[] }
      | null = null;
    if (!patientId && status === "COMPLETED") {
      const qStr = typeof q === "string" ? q : "";
      const { ids, total } = await computeCompletedClinicIndex(
        req.branchId!,
        typeof from === "string" ? from : undefined,
        typeof to === "string" ? to : undefined,
        typeof visitType === "string" ? visitType : undefined,
        typeof doctorId === "string" ? doctorId : undefined,
        qStr,
      );
      const pageNum = Math.max(1, parseInt(String(page ?? "1"), 10) || 1);
      const size = Math.min(
        100,
        Math.max(1, parseInt(String(pageSize ?? "20"), 10) || 20),
      );
      const totalPages = Math.max(1, Math.ceil(total / size));
      const clampedPage = Math.min(pageNum, totalPages);
      const start = (clampedPage - 1) * size;
      const pageIds = ids.slice(start, start + size);
      paginated = { total, page: clampedPage, pageSize: size, totalPages, order: pageIds };
      // Hydrate ONLY this page's rows below.
      delete where.branchId;
      delete where.clinicVisit;
      where.id = { in: pageIds };
    }

    const visits = await prisma.visit.findMany({
      where,
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        clinicVisit: {
          include: {
            clinicDoctor: true,
          },
        },
        bill: { include: { transactions: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const originalVisitMap = await loadOriginalVisitMap(
      prisma,
      visits.map((visit) => visit.clinicVisit?.originalVisitId),
    );

    let filteredVisits = visits;
    if (doctorId) {
      filteredVisits = visits.filter(
        (visit) => visit.clinicVisit?.clinicDoctorId === doctorId,
      );
    }

    const transformed = filteredVisits.map((visit) =>
      transformClinicVisit(visit, originalVisitMap),
    );

    // Finalized OP/IP worklist: return the page in the cached index's order (a
    // findMany with `id: { in: [...] }` doesn't preserve id order), wrapped in
    // the paginated envelope the client expects. `transformed` is only this
    // page's ≤20 rows.
    if (paginated) {
      const byId = new Map(transformed.map((t) => [t.id, t]));
      const items = paginated.order
        .map((id) => byId.get(id))
        .filter((t): t is (typeof transformed)[number] => Boolean(t));
      return res.json({
        items,
        total: paginated.total,
        page: paginated.page,
        pageSize: paginated.pageSize,
        totalPages: paginated.totalPages,
      });
    }

    return res.json(transformed);
  } catch (err: any) {
    console.error("List clinic visits error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to list clinic visits",
    });
  }
});

// GET /api/visits/clinic/revisit-context - Canonical revisit eligibility for same patient + doctor + branch
router.get("/revisit-context", async (req: AuthRequest, res) => {
  try {
    const { patientId, doctorId } = req.query;

    if (!patientId || !doctorId) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "patientId and doctorId are required",
      });
    }

    const anchorVisit = await findLatestRevisitAnchor(prisma, {
      branchId: req.branchId!,
      patientId: patientId as string,
      doctorId: doctorId as string,
    });

    return res.json(buildRevisitContext(anchorVisit));
  } catch (err: any) {
    console.error("Revisit context error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to load revisit context",
    });
  }
});

// GET /api/visits/clinic/:id - Get single clinic visit
router.get("/:id", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "CLINIC",
      },
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        clinicVisit: {
          include: {
            clinicDoctor: true,
          },
        },
        bill: { include: { transactions: true } },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Clinic visit not found",
      });
    }

    const originalVisitMap = await loadOriginalVisitMap(prisma, [
      visit.clinicVisit?.originalVisitId,
    ]);

    return res.json(transformClinicVisit(visit, originalVisitMap));
  } catch (err: any) {
    console.error("Get clinic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to get clinic visit",
    });
  }
});

// POST /api/visits/clinic - Create new clinic visit
router.post("/", async (req: AuthRequest, res) => {
  try {
    const {
      patientId,
      doctorId,
      visitType,
      hospitalWard,
      consultationFee,
      paymentType,
      paymentStatus,
      payments,
      paidAmount,
      revisitDecision,
      sendWhatsApp,
    } = req.body;

    if (
      !patientId ||
      !doctorId ||
      !visitType ||
      consultationFee === undefined
    ) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message:
          "Patient ID, doctor ID, visit type, and consultation fee are required",
      });
    }

    const normalizedConsultationFee = Number(consultationFee);
    if (
      Number.isNaN(normalizedConsultationFee) ||
      normalizedConsultationFee < 0
    ) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Consultation fee must be a valid non-negative number",
      });
    }

    const normalizedDecision = normalizeRevisitDecision(revisitDecision);

    const branch = await prisma.branch.findUnique({
      where: { id: req.branchId },
    });

    if (!branch) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Invalid branch",
      });
    }

    const doctor = await prisma.clinicDoctor.findUnique({
      where: { id: doctorId },
    });

    if (!doctor) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Doctor not found",
      });
    }

    const { anchorVisit, revisitMode, isRevisit } =
      await resolveRevisitSelection(prisma, {
        branchId: req.branchId!,
        patientId,
        doctorId,
        revisitDecision: normalizedDecision,
      });

    const consultationFeeInPaise = Math.round(
      (isRevisit ? 0 : normalizedConsultationFee) * 100,
    );
    const visitRef = await generateClinicBillNumber(branch.code);

    // Waiting-room queue token — assigned at registration, resets daily per
    // doctor. Each doctor gets their own independent queue (e.g. SC-01, SC-02).
    // Only OP visits appear on the waiting-room display, so IP visits get no
    // token. Generated before the main transaction (like visitRef) because the
    // sequence helper opens its own transaction.
    const opTokenNumber =
      visitType === "OP"
        ? await generateOpTokenNumber(branch.code, doctorId)
        : null;

    const result = await prisma.$transaction(async (tx) => {
      // Idempotency guard — same reasoning as the diagnostic registration:
      // one run creates Visit + Bill + PaymentTransaction, and nothing else
      // stops a resubmit. Serialize on (domain, branch, patient) FIRST, because
      // a bare SELECT would let two concurrent requests both look, both find
      // nothing, and both insert. The check reads through `tx` so the lock
      // actually covers it.
      const dupLockId = duplicateVisitLockId(
        "CLINIC",
        req.branchId!,
        patientId,
      );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${dupLockId})`;
      const recentTwin = await tx.visit.findFirst({
        where: {
          branchId: req.branchId!,
          patientId,
          domain: "CLINIC",
          totalAmountInPaise: consultationFeeInPaise,
          status: { not: "CANCELLED" },
          createdAt: { gte: new Date(Date.now() - DUPLICATE_VISIT_WINDOW_MS) },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, billNumber: true },
      });
      if (recentTwin) {
        throw new DuplicateVisitError(recentTwin.billNumber);
      }

      const visit = await tx.visit.create({
        data: {
          branchId: req.branchId!,
          patientId,
          domain: "CLINIC",
          status: "WAITING",
          billNumber: visitRef,
          totalAmountInPaise: consultationFeeInPaise,
        },
      });

      if (!isRevisit) {
        const paidAmt =
          paymentStatus === "PAID"
            ? consultationFeeInPaise
            : paidAmount
              ? Math.round(paidAmount * 100)
              : 0;
        await tx.bill.create({
          data: {
            visitId: visit.id,
            billNumber: visitRef,
            branchId: req.branchId!,
            totalAmountInPaise: consultationFeeInPaise,
            paidAmountInPaise: paidAmt,
            paymentStatus: paymentStatus || "PENDING",
            ...(paidAmt > 0 && {
              transactions: {
                create:
                  Array.isArray(payments) && payments.length > 0
                    ? payments.map((p) => ({
                        amountInPaise: Math.round((p.amount || 0) * 100),
                        paymentType: p.type || "CASH",
                        collectedByUserId: req.user!.id,
                      }))
                    : [
                        {
                          amountInPaise: paidAmt,
                          paymentType: paymentType || "CASH",
                          collectedByUserId: req.user!.id,
                        },
                      ],
              },
            }),
          },
        });
      }

      await tx.clinicVisit.create({
        data: {
          visitId: visit.id,
          clinicDoctorId: doctorId,
          visitType,
          hospitalWard: visitType === "IP" ? hospitalWard : null,
          consultationFeeInPaise,
          isRevisit,
          originalVisitId: isRevisit ? anchorVisit?.id || null : null,
          status: "WAITING",
          tokenNumber: opTokenNumber,
        },
      });

      await logAction({
        userId: req.user?.id!,
        actionType: "CREATE",
        entityType: "VISIT",
        entityId: visit.id,
        branchId: req.branchId!,
        newValues: {
          domain: "CLINIC",
          visitRef,
          billNumber: isRevisit ? null : visitRef,
          patientId,
          doctorId,
          visitType,
          revisitDecision: normalizedDecision,
          revisitMode,
          isRevisit,
          originalVisitId: isRevisit ? anchorVisit?.id || null : null,
        },
      });

      return visit;
    });

    const completeVisit = await prisma.visit.findUnique({
      where: { id: result.id },
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        clinicVisit: {
          include: {
            clinicDoctor: true,
          },
        },
        bill: { include: { transactions: true } },
      },
    });

    if (!completeVisit) {
      throw createHttpError(
        500,
        "INTERNAL_ERROR",
        "Failed to load created clinic visit",
      );
    }

    const originalVisitMap = await loadOriginalVisitMap(prisma, [
      completeVisit.clinicVisit?.originalVisitId,
    ]);

    const transformedVisit = transformClinicVisit(
      completeVisit,
      originalVisitMap,
    );

    if (sendWhatsApp && completeVisit.bill) {
      import("../services/notificationService").then(
        ({ sendBillConfirmation }) => {
          sendBillConfirmation(result.id).catch((err) =>
            console.error(
              "[Notification] Bill notification failed (non-blocking):",
              err.message,
            ),
          );
        },
      );
    }

    return res.status(201).json(transformedVisit);
  } catch (err: any) {
    // The registration was already recorded moments ago — this is a resubmit,
    // not a second visit. The transaction rolled back, so nothing was written;
    // report the bill that already exists rather than billing twice.
    if (err instanceof DuplicateVisitError) {
      return res.status(409).json({
        error: "DUPLICATE_VISIT",
        existingBillNumber: err.existingBillNumber,
        message: `This patient was already registered as ${err.existingBillNumber} moments ago. No second bill was created.`,
      });
    }

    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message,
      });
    }

    console.error("Create clinic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to create clinic visit",
    });
  }
});

// PATCH /api/visits/clinic/:id - Update clinic visit status
router.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus, paymentType } = req.body;

    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "CLINIC",
      },
      include: {
        clinicVisit: { include: { clinicDoctor: true } },
        bill: { include: { transactions: true } },
      },
    });

    if (!existing) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Clinic visit not found",
      });
    }

    if (
      req.body.visitType &&
      req.body.visitType !== existing.clinicVisit?.visitType
    ) {
      return res.status(403).json({
        error: "IMMUTABLE_FIELD",
        message: "Visit type cannot be changed after creation",
      });
    }

    if ((paymentStatus || paymentType) && !existing.bill) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "This visit has no bill to update",
      });
    }

    if (status && existing.status !== status) {
      const validTransitions: Record<string, string[]> = {
        WAITING: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
        IN_PROGRESS: ["COMPLETED"],
        COMPLETED: [],
        CANCELLED: [],
      };

      const allowedStates = validTransitions[existing.status] || [];
      if (!allowedStates.includes(status)) {
        return res.status(400).json({
          error: "INVALID_TRANSITION",
          message: `Cannot transition from ${existing.status} to ${status}`,
        });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (status) {
        const nextStatus = status as VisitStatus;
        const clinicVisitStatusData: {
          status: VisitStatus;
          startedAt?: Date;
          completedAt?: Date;
        } = { status: nextStatus };

        if (existing.clinicVisit) {
          if (nextStatus === "IN_PROGRESS" && !existing.clinicVisit.startedAt) {
            clinicVisitStatusData.startedAt = new Date();
          }

          if (nextStatus === "COMPLETED" && !existing.clinicVisit.completedAt) {
            clinicVisitStatusData.completedAt = new Date();
          }
        }

        await tx.visit.update({
          where: { id },
          data: { status: nextStatus },
        });

        await logAction({
          userId: req.user?.id!,
          actionType: "UPDATE",
          entityType: "VISIT",
          entityId: id,
          branchId: req.branchId!,
          oldValues: { status: existing.status },
          newValues: {
            status: nextStatus,
            ...(clinicVisitStatusData.startedAt && {
              startedAt: clinicVisitStatusData.startedAt.toISOString(),
            }),
            ...(clinicVisitStatusData.completedAt && {
              completedAt: clinicVisitStatusData.completedAt.toISOString(),
            }),
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });

        if (existing.clinicVisit) {
          await tx.clinicVisit.update({
            where: { id: existing.clinicVisit.id },
            data: clinicVisitStatusData,
          });

          if (status === "COMPLETED" && existing.status !== "COMPLETED") {
            const visitDate = clinicVisitStatusData.completedAt ?? new Date();
            const startOfDay = new Date(visitDate.setHours(0, 0, 0, 0));
            const endOfDay = new Date(visitDate.setHours(23, 59, 59, 999));
            const consultationAmountInPaise =
              existing.clinicVisit.consultationFeeInPaise ||
              existing.totalAmountInPaise ||
              0;
            // The payout is the doctor's COMMISSION of the fee, not the full
            // fee. Mirror deriveClinicPayout (payoutService.ts): FIXED_AMOUNT →
            // fixed amount, else percentage of fee (default 100%).
            const payoutDoctor = existing.clinicVisit.clinicDoctor;
            const commissionAmountInPaise =
              payoutDoctor?.commissionType === "FIXED_AMOUNT" &&
              payoutDoctor.commissionAmountInPaise != null
                ? payoutDoctor.commissionAmountInPaise
                : Math.round(
                    (consultationAmountInPaise *
                      (payoutDoctor?.commissionPercent ?? 100)) /
                      100,
                  );

            const existingDayLedger = await tx.doctorPayoutLedger.findFirst({
              where: {
                branchId: existing.branchId,
                doctorType: "CLINIC",
                clinicDoctorId: existing.clinicVisit.clinicDoctorId,
                periodStartDate: startOfDay,
                periodEndDate: endOfDay,
              },
              orderBy: { derivedAt: "desc" },
            });

            const coveringPaidLedger = await tx.doctorPayoutLedger.findFirst({
              where: {
                branchId: existing.branchId,
                doctorType: "CLINIC",
                clinicDoctorId: existing.clinicVisit.clinicDoctorId,
                paidAt: { not: null },
                periodStartDate: { lte: startOfDay },
                periodEndDate: { gte: endOfDay },
              },
              orderBy: [
                { periodStartDate: "desc" },
                { periodEndDate: "asc" },
                { paidAt: "desc" },
              ],
            });

            if (existingDayLedger) {
              await tx.doctorPayoutLedger.update({
                where: { id: existingDayLedger.id },
                data: {
                  derivedAmountInPaise:
                    existingDayLedger.derivedAmountInPaise +
                    commissionAmountInPaise,
                  derivedAt: new Date(),
                  notes: `Clinic consultations - ${startOfDay.toISOString().slice(0, 10)}`,
                  ...(!existingDayLedger.paidAt &&
                    coveringPaidLedger?.paidAt && {
                      paidAt: coveringPaidLedger.paidAt,
                      paymentMethod: coveringPaidLedger.paymentMethod,
                      paymentReferenceId: coveringPaidLedger.paymentReferenceId,
                    }),
                },
              });
            } else {
              await tx.doctorPayoutLedger.create({
                data: {
                  branchId: existing.branchId,
                  doctorType: "CLINIC",
                  clinicDoctorId: existing.clinicVisit.clinicDoctorId,
                  periodStartDate: startOfDay,
                  periodEndDate: endOfDay,
                  derivedAmountInPaise: commissionAmountInPaise,
                  derivedAt: new Date(),
                  notes:
                    coveringPaidLedger?.notes ||
                    `Clinic consultation - ${existing.billNumber}`,
                  ...(coveringPaidLedger?.paidAt && {
                    paidAt: coveringPaidLedger.paidAt,
                    paymentMethod: coveringPaidLedger.paymentMethod,
                    paymentReferenceId: coveringPaidLedger.paymentReferenceId,
                  }),
                },
              });
            }
          }
        }
      }

      if (paymentStatus || paymentType) {
        if (paymentStatus && paymentStatus === "PAID" && existing.bill) {
          const currentAmount = existing.bill.paidAmountInPaise || 0;
          const dueAmount =
            existing.bill.totalAmountInPaise -
            existing.bill.discountAmountInPaise -
            currentAmount;
          if (dueAmount > 0) {
            await tx.bill.update({
              where: { id: existing.bill.id },
              data: {
                paidAmountInPaise: currentAmount + dueAmount,
                paymentStatus: "PAID",
                transactions: {
                  create: {
                    amountInPaise: dueAmount,
                    paymentType: paymentType || "CASH",
                    collectedByUserId: req.user!.id,
                  },
                },
              },
            });
          }
        } else {
          await tx.bill.updateMany({
            where: { visitId: id },
            data: {
              ...(paymentStatus && { paymentStatus }),
            },
          });
        }

        const oldPaymentData = {
          paymentStatus: existing.bill?.paymentStatus,
          paymentType:
            Array.isArray((existing as any).bill?.transactions) &&
            (existing as any).bill.transactions.length > 0
              ? Array.from(
                  new Set(
                    (existing as any).bill.transactions.map(
                      (t: any) => t.paymentType,
                    ),
                  ),
                ).join(", ")
              : null,
        };

        await logAction({
          userId: req.user?.id!,
          actionType: "UPDATE",
          entityType: "BILL",
          entityId: id,
          branchId: req.branchId!,
          oldValues: oldPaymentData,
          newValues: {
            ...(paymentStatus && { paymentStatus }),
            ...(paymentType && { paymentType }),
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      return tx.visit.findUnique({
        where: { id },
        include: {
          bill: { include: { transactions: true } },
          clinicVisit: true,
        },
      });
    });

    // A queue status change (call next / complete / cancel) → push the waiting-room
    // displays for this branch instantly instead of waiting for their next poll.
    if (status && existing.status !== status) emitBranchChange(req.branchId!);

    return res.json({
      id: updated!.id,
      hasBill: Boolean(updated!.bill),
      status: updated!.clinicVisit?.status || updated!.status,
      paymentStatus: updated!.bill?.paymentStatus || null,
      paymentType:
        Array.isArray((existing as any).bill?.transactions) && (existing as any).bill.transactions.length > 0 ? Array.from(new Set((existing as any).bill.transactions.map((t: any) => t.paymentType))).join(', ') : null,
      billedAt: updated!.bill?.billedAt || updated!.bill?.createdAt || null,
      startedAt: updated!.clinicVisit?.startedAt || null,
      completedAt: updated!.clinicVisit?.completedAt || null,
    });
  } catch (err: any) {
    console.error("Update clinic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to update clinic visit",
    });
  }
});

// DELETE /api/visits/clinic/:id - Cancel clinic visit
//
// Cancellation must reverse the visit's financial side effects:
//   1. Block the cancel if the bill is paid — staff must refund manually
//      first (or owner can override via ?force=true) so the cash side stays
//      auditable.
//   2. Decrement the doctor's payout ledger entry for the day if the visit
//      was COMPLETED (which is the only path that increments the ledger).
//      Without this, doctors get paid for cancelled consults silently.
router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const force = req.query.force === 'true';

    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "CLINIC",
      },
      include: {
        bill: true,
        clinicVisit: true,
      },
    });

    if (!existing) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Clinic visit not found",
      });
    }

    if (existing.status === 'CANCELLED') {
      return res.json({ success: true, alreadyCancelled: true });
    }

    const billPaidPaise = existing.bill?.paidAmountInPaise ?? 0;
    if (billPaidPaise > 0 && !(force && req.user?.role === 'owner')) {
      return res.status(409).json({
        error: 'BILL_PAID',
        message: `Cannot cancel — bill has ₹${(billPaidPaise / 100).toFixed(2)} already paid. Refund first, or owner can override with ?force=true.`,
        paidAmountInPaise: billPaidPaise,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.visit.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      if (existing.clinicVisit) {
        await tx.clinicVisit.update({
          where: { id: existing.clinicVisit.id },
          data: { status: 'CANCELLED' },
        });
      }

      // Undo the day's payout ledger entry if PATCH /:id ever marked this
      // visit COMPLETED (which is the codepath that adds consultation fees
      // to DoctorPayoutLedger). Skip if the doctor was already paid — that
      // becomes an out-of-band ops correction.
      if (
        existing.status === 'COMPLETED' &&
        existing.clinicVisit?.clinicDoctorId &&
        existing.clinicVisit.completedAt
      ) {
        const completedAt = existing.clinicVisit.completedAt;
        const startOfDay = new Date(completedAt);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(completedAt);
        endOfDay.setHours(23, 59, 59, 999);

        const dayLedger = await tx.doctorPayoutLedger.findFirst({
          where: {
            branchId: existing.branchId,
            doctorType: 'CLINIC',
            clinicDoctorId: existing.clinicVisit.clinicDoctorId,
            periodStartDate: startOfDay,
            periodEndDate: endOfDay,
          },
        });

        const fee = existing.clinicVisit.consultationFeeInPaise || existing.totalAmountInPaise || 0;
        if (dayLedger && !dayLedger.paidAt && fee > 0) {
          const nextAmount = Math.max(0, dayLedger.derivedAmountInPaise - fee);
          if (nextAmount === 0) {
            await tx.doctorPayoutLedger.delete({ where: { id: dayLedger.id } });
          } else {
            await tx.doctorPayoutLedger.update({
              where: { id: dayLedger.id },
              data: { derivedAmountInPaise: nextAmount, derivedAt: new Date() },
            });
          }
        }
      }
    });

    await logAction({
      userId: req.user?.id!,
      actionType: 'DELETE',
      entityType: 'VISIT',
      entityId: id,
      branchId: req.branchId!,
      oldValues: {
        status: existing.status,
        billNumber: existing.billNumber,
        paidAmountInPaise: billPaidPaise,
      },
      newValues: { status: 'CANCELLED', forced: force },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ success: true });
  } catch (err: any) {
    console.error("Delete clinic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to delete clinic visit",
    });
  }
});

export default router;
