import { Prisma, VisitStatus } from "@prisma/client";
import { Router } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { branchContextMiddleware } from "../middleware/branch";
import prisma from "../lib/prisma";
import { logAction } from "../services/auditService";
import { generateClinicBillNumber } from "../services/numberService";
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
    bill: true;
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
      bill: true,
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
    paymentType: null,
    paymentStatus: visit.bill?.paymentStatus || null,
    billedAt: visit.bill?.billedAt || visit.bill?.createdAt || null,
    startedAt: visit.clinicVisit?.startedAt || null,
    completedAt: visit.clinicVisit?.completedAt || null,
    createdAt: visit.createdAt,
    updatedAt: visit.updatedAt,
  };
}

// GET /api/visits/clinic - List clinic visits
// When patientId is provided: Returns ALL visits for that patient across ALL branches (Patient 360 view)
// When patientId is omitted: Returns visits for current branch only (daily operations)
router.get("/", async (req: AuthRequest, res) => {
  try {
    const { status, doctorId, patientId } = req.query;

    const where: any = {
      domain: "CLINIC",
    };

    if (patientId) {
      where.patientId = patientId;
    } else {
      where.branchId = req.branchId;
    }

    if (status) {
      where.clinicVisit = { status };
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
        bill: true,
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

    return res.json(
      filteredVisits.map((visit) =>
        transformClinicVisit(visit, originalVisitMap),
      ),
    );
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
        bill: true,
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

    const result = await prisma.$transaction(async (tx) => {
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
        await tx.bill.create({
          data: {
            visitId: visit.id,
            billNumber: visitRef,
            branchId: req.branchId!,
            totalAmountInPaise: consultationFeeInPaise,

            paymentStatus: paymentStatus || "PENDING",
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
        bill: true,
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
        clinicVisit: true,
        bill: true,
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
                    consultationAmountInPaise,
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
                  derivedAmountInPaise: consultationAmountInPaise,
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
          paymentType: null,
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
        include: { bill: true, clinicVisit: true },
      });
    });

    return res.json({
      id: updated!.id,
      hasBill: Boolean(updated!.bill),
      status: updated!.clinicVisit?.status || updated!.status,
      paymentStatus: updated!.bill?.paymentStatus || null,
      paymentType: null,
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

// DELETE /api/visits/clinic/:id - Delete/cancel clinic visit
router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "CLINIC",
      },
    });

    if (!existing) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Clinic visit not found",
      });
    }

    await prisma.visit.update({
      where: { id },
      data: { status: "CANCELLED" },
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
