# File: src/routes/diagnosticVisits.ts (Part 3)

Lines 1701–2550 of 4146.

```ts
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
                isActive: true,
              },
            });
          }
        }

        // Create test orders with metadata snapshot (E3-03)
        await tx.testOrder.createMany({
          data: testOrderData.map((tod) => ({
            visitId: visit.id,
            testId: tod.testId,
            branchId: req.branchId!,
            workflowMode: tod.workflowMode,
            priceInPaise: tod.priceInPaise,
            referralCommissionType: tod.referralCommissionType,
            referralCommissionPercentage: tod.referralCommissionPercentage,
            referralCommissionAmountInPaise:
              tod.referralCommissionAmountInPaise,
            diagnosticCenterCommissionType: tod.diagnosticCenterCommissionType,
            diagnosticCenterCommissionPercentage:
              tod.diagnosticCenterCommissionPercentage,
            diagnosticCenterCommissionAmountInPaise:
              tod.diagnosticCenterCommissionAmountInPaise,
            testNameSnapshot: tod.testNameSnapshot,
            testCodeSnapshot: tod.testCodeSnapshot,
            referenceMinSnapshot: tod.referenceMinSnapshot,
            referenceMaxSnapshot: tod.referenceMaxSnapshot,
            referenceUnitSnapshot: tod.referenceUnitSnapshot,
            testDefinitionId: tod.testDefinitionId ?? null,
            productId: tod.productId ?? null,
          })),
        });

        if (createComposition.hasReportInclusionOrders) {
          // Both REPORTABLE and EXTERNAL_UPLOAD orders flow into a single
          // DiagnosticReport — the merged PDF combines rendered values with
          // appended uploads.
          const report = await tx.diagnosticReport.create({
            data: {
              visitId: visit.id,
              branchId: req.branchId!,
            },
          });

          await tx.reportVersion.create({
            data: {
              reportId: report.id,
              versionNum: 1,
              status: "DRAFT",
            },
          });
        }

        return visit;
      },
      {
        timeout: 15000,
        maxWait: 15000,
      },
    );

    void logAction({
      userId: req.user?.id!,
      actionType: "CREATE",
      entityType: "VISIT",
      entityId: result.id,
      branchId: req.branchId!,
      newValues: {
        domain: "DIAGNOSTICS",
        billNumber,
        patientId,
        totalAmountInPaise,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    // Auto-refresh payouts only for pure bill-only visits (already COMPLETED).
    // Visits with REPORTABLE/EXTERNAL_UPLOAD orders complete payouts at finalize time.
    if (!createComposition.hasReportInclusionOrders) {
      const completedAt = new Date();
      const periodStartDate = new Date(completedAt);
      periodStartDate.setHours(0, 0, 0, 0);
      const periodEndDate = new Date(completedAt);
      periodEndDate.setHours(23, 59, 59, 999);

      const payoutRefreshTasks: Array<Promise<unknown>> = [];

      if (referralDoctorId) {
        payoutRefreshTasks.push(
          derivePayout(
            "REFERRAL",
            referralDoctorId,
            req.branchId!,
            periodStartDate,
            periodEndDate,
          ),
        );
      }

      if (diagnosticCenterId) {
        payoutRefreshTasks.push(
          derivePayout(
            "DIAGNOSTIC_CENTER",
            diagnosticCenterId,
            req.branchId!,
            periodStartDate,
            periodEndDate,
          ),
        );
      }

      if (payoutRefreshTasks.length > 0) {
        const refreshResults = await Promise.allSettled(payoutRefreshTasks);
        for (const refreshResult of refreshResults) {
          if (refreshResult.status === "rejected") {
            console.error(
              "Auto-refresh payout after bill-only billing failed:",
              refreshResult.reason,
            );
          }
        }
      }
    }

    // Fetch complete visit for response
    const completeVisit = await prisma.visit.findUnique({
      where: { id: result.id },
      include: {
        patient: { include: { identifiers: true } },
        referrals: { include: { referralDoctor: true } },
        testOrders: {
          include: {
            test: true,
            product: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
        bill: { include: { transactions: true } },
      },
    });

    // Fire-and-forget: Send bill confirmation via WhatsApp (non-blocking)
    if (sendWhatsApp) {
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

    const completeBillFinancials = buildBillFinancialResponse(
      completeVisit!.bill,
    );

    return res.status(201).json({
      id: completeVisit!.id,
      billNumber: completeVisit!.billNumber,
      patientId: completeVisit!.patientId,
      totalAmount: completeVisit!.totalAmountInPaise / 100,
      status: completeVisit!.status,
      hasBill: true,
      paymentType:
        Array.isArray((completeVisit as any)!.bill?.transactions) &&
        (completeVisit as any)!.bill.transactions.length > 0
          ? Array.from(
              new Set(
                ((completeVisit as any)!.bill.transactions as any[]).map(
                  (t) => t.paymentType,
                ),
              ),
            ).join(", ")
          : null,
      paymentStatus: completeVisit!.bill?.paymentStatus || "PENDING",
      ...completeBillFinancials,
      billedAt:
        completeVisit!.bill?.billedAt || completeVisit!.bill?.createdAt || null,
      reportFinalizedAt: null,
      hasReportableOrders: createComposition.hasReportableOrders,
      hasBillOnlyOrders: createComposition.hasBillOnlyOrders,
      hasExternalUploadOrders: createComposition.hasExternalUploadOrders,
      hasReportInclusionOrders: createComposition.hasReportInclusionOrders,
      hasEntryScreenOrders: createComposition.hasEntryScreenOrders,
      hasFinalizedReport: false,
      nextAction: getVisitComposition(
        completeVisit!.testOrders,
        completeVisit!.status,
      ).nextAction,
      createdAt: completeVisit!.createdAt,
      referralDoctor: completeVisit!.referrals[0]?.referralDoctor || null,
      billItems: buildDiagnosticBillItems(
        completeVisit!.testOrders.map((to) => ({
          id: to.id,
          productId: to.productId,
          product: to.product
            ? {
                id: to.product.id,
                name: to.product.name,
                code: to.product.code,
              }
            : null,
          testName: to.testNameSnapshot || to.test.name,
          testCode: to.testCodeSnapshot || to.test.code,
          priceInPaise: to.priceInPaise,
          referralCommissionType: completeVisit!.referrals[0]?.referralDoctor
            ? to.referralCommissionType
            : undefined,
          referralCommissionPercentage: completeVisit!.referrals[0]
            ?.referralDoctor
            ? to.referralCommissionPercentage
            : undefined,
          referralCommissionAmountInPaise: completeVisit!.referrals[0]
            ?.referralDoctor
            ? to.referralCommissionAmountInPaise
            : undefined,
        })),
      ),
      testOrders: completeVisit!.testOrders.map((to) => ({
        id: to.id,
        visitId: to.visitId,
        testId: to.testId,
        productId: to.productId,
        testDefinitionId: to.testDefinitionId,
        workflowMode: to.workflowMode,
        testName: to.testNameSnapshot || to.test.name,
        testCode: to.testCodeSnapshot || to.test.code,
        priceInPaise: to.priceInPaise,
        referralCommissionType: to.referralCommissionType,
        referralCommissionPercent: to.referralCommissionPercentage,
        referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
        diagnosticCenterCommissionType: to.diagnosticCenterCommissionType,
        diagnosticCenterCommissionPercent:
          to.diagnosticCenterCommissionPercentage,
        diagnosticCenterCommissionAmountInPaise:
          to.diagnosticCenterCommissionAmountInPaise,
      })),
    });
  } catch (err: any) {
    console.error("Create diagnostic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to create diagnostic visit",
    });
  }
});

// PATCH /api/visits/diagnostic/:id - Update diagnostic visit status
router.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { status, paymentType, paidAmount } = req.body;

    // Check visit exists
    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: { bill: { include: { transactions: true } } },
    });

    if (!existing) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    let nextBillFinancials = null;
    if (paidAmount !== undefined) {
      if (!existing.bill) {
        return res.status(400).json({
          error: "BILL_NOT_FOUND",
          message: "No bill found for this diagnostic visit",
        });
      }

      try {
        nextBillFinancials = normalizeBillFinancialInput({
          totalAmountInPaise: existing.bill.totalAmountInPaise,
          discountReason: existing.bill.discountReason,
          discountType: existing.bill.discountType,
          discountValue:
            existing.bill.discountType === "PERCENTAGE"
              ? (existing.bill.discountPercentage ?? 0)
              : existing.bill.discountAmountInPaise / 100,
          paidAmount,
        });
      } catch (validationErr: any) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: validationErr.message,
        });
      }
    }

    // Update visit
    const updated = await prisma.$transaction(async (tx) => {
      if (status) {
        await tx.visit.update({
          where: { id },
          data: { status },
        });
      }

      // Update bill financials if provided (paymentType no longer exists on bill)
      if (nextBillFinancials) {
        const currentBillFinancials = buildBillFinancialResponse(existing.bill);

        await tx.bill.updateMany({
          where: { visitId: id },
          data: {
            paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
            paymentStatus: nextBillFinancials.paymentStatus,
          },
        });

        // Record additive transaction for the newly paid amount
        const previousPaid = currentBillFinancials.paidAmountInPaise;
        const newPaid = nextBillFinancials.paidAmountInPaise;
        const addedAmount = newPaid - previousPaid;

        if (addedAmount > 0 && existing.bill) {
          await tx.paymentTransaction.create({
            data: {
              billId: existing.bill.id,
              amountInPaise: addedAmount,
              paymentType: paymentType || "CASH",
              collectedByUserId: req.user!.id,
            },
          });
        }
      }

      return tx.visit.findUnique({
        where: { id },
        include: { bill: { include: { transactions: true } } },
      });
    });
    const billFinancials = buildBillFinancialResponse(updated!.bill);

    return res.json({
      id: updated!.id,
      status: updated!.status,
      paymentStatus: updated!.bill?.paymentStatus,
      paymentType:
        Array.isArray((updated as any)!.bill?.transactions) &&
        (updated as any)!.bill.transactions.length > 0
          ? Array.from(
              new Set(
                ((updated as any)!.bill.transactions as any[]).map(
                  (t) => t.paymentType,
                ),
              ),
            ).join(", ")
          : null,
      ...billFinancials,
      billedAt: updated!.bill?.billedAt || updated!.bill?.createdAt || null,
    });
  } catch (err: any) {
    console.error("Update diagnostic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to update diagnostic visit",
    });
  }
});

// POST /api/visits/diagnostic/:id/collect-due - Collect an additive due payment
router.post("/:id/collect-due", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { amount, paymentType } = req.body;

    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: { bill: { include: { transactions: true } } },
    });

    if (!existing) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    if (!existing.bill) {
      return res.status(400).json({
        error: "BILL_NOT_FOUND",
        message: "No bill found for this diagnostic visit",
      });
    }

    let nextBillFinancials;
    try {
      nextBillFinancials = collectBillDue(existing.bill, amount);
    } catch (validationErr: any) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: validationErr.message,
      });
    }

    const currentBillFinancials = buildBillFinancialResponse(existing.bill);
    const addedAmountInPaise = Math.max(
      0,
      nextBillFinancials.paidAmountInPaise -
        currentBillFinancials.paidAmountInPaise,
    );
    if (addedAmountInPaise <= 0) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Collection amount must increase paid amount",
      });
    }

    const normalizedPaymentType =
      paymentType === "ONLINE" ? "ONLINE" : "CASH";

    const updated = await prisma.bill.update({
      where: { id: existing.bill.id },
      data: {
        paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
        paymentStatus: nextBillFinancials.paymentStatus,
        transactions: {
          create: {
            amountInPaise: addedAmountInPaise,
            paymentType: normalizedPaymentType,
            collectedByUserId: req.user!.id,
          },
        },
      },
      include: { transactions: true },
    });

    const billFinancials = buildBillFinancialResponse(updated);

    return res.json({
      id: existing.id,
      status: existing.status,
      paymentType:
        Array.isArray((updated as any).transactions) &&
        (updated as any).transactions.length > 0
          ? Array.from(
              new Set(
                ((updated as any).transactions as any[]).map(
                  (t) => t.paymentType,
                ),
              ),
            ).join(", ")
          : null,
      paymentStatus: updated.paymentStatus,
      ...billFinancials,
      billedAt: updated.billedAt || updated.createdAt,
    });
  } catch (err: any) {
    console.error("Collect diagnostic due error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to collect due payment",
    });
  }
});

// POST /api/visits/diagnostic/:id/tests - Add tests to existing visit (E3-03)
// Tests can only be added before report finalization
router.post("/:id/tests", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { testIds } = req.body;

    // Validation
    if (!testIds || !Array.isArray(testIds) || testIds.length === 0) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "At least one test ID is required",
      });
    }

    // Get visit with report status
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        referrals: {
          include: {
            referralDoctor: true,
          },
        },
        diagnosticCenterReferrals: {
          include: {
            diagnosticCenter: true,
          },
        },
        testOrders: {
          select: {
            id: true,
            testId: true,
            workflowMode: true,
            priceInPaise: true,
          },
        },
        bill: { include: { transactions: true } },
        report: {
          include: {
            versions: {
              where: { status: "FINALIZED" },
              take: 1,
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    // E3-03: Check if report is finalized - cannot add tests after finalization
    const hasFinalized =
      visit.report?.versions && visit.report.versions.length > 0;
    if (hasFinalized) {
      return res.status(400).json({
        error: "REPORT_FINALIZED",
        message: "Cannot add tests after report has been finalized",
      });
    }

    if (isPureBillOnlyVisit(visit.testOrders)) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message:
          "Pure bill-only visits cannot be converted into reportable visits through add-tests.",
      });
    }

    // Check if any requested tests are already ordered
    const existingTestIds = visit.testOrders.map((to) => to.testId);
    const duplicateTests = testIds.filter((id: string) =>
      existingTestIds.includes(id),
    );
    if (duplicateTests.length > 0) {
      return res.status(400).json({
        error: "DUPLICATE_TESTS",
        message: "Some tests are already ordered for this visit",
        duplicateTestIds: duplicateTests,
      });
    }

    // Get tests with prices
    const tests = await prisma.labTest.findMany({
      where: { id: { in: testIds }, isActive: true },
    });

    if (tests.length !== testIds.length) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "One or more tests not found or inactive",
      });
    }

    const defaultReferralRule =
      visit.referrals.length > 0 && visit.referrals[0].referralDoctor
        ? {
            commissionType: visit.referrals[0].referralDoctor.commissionType,
            commissionPercent:
              visit.referrals[0].referralDoctor.commissionPercent,
            commissionAmountInPaise:
              visit.referrals[0].referralDoctor.commissionAmountInPaise,
          }
        : null;
    const defaultDiagnosticCenterRule =
      visit.diagnosticCenterReferrals.length > 0 &&
      visit.diagnosticCenterReferrals[0].diagnosticCenter
        ? {
            commissionType:
              visit.diagnosticCenterReferrals[0].diagnosticCenter
                .commissionType,
            commissionPercent:
              visit.diagnosticCenterReferrals[0].diagnosticCenter
                .commissionPercent,
            commissionAmountInPaise:
              visit.diagnosticCenterReferrals[0].diagnosticCenter
                .commissionAmountInPaise,
          }
        : null;

    // Calculate additional amount
    const additionalAmountInPaise = tests.reduce(
      (sum, t) => sum + t.priceInPaise,
      0,
    );
    const newTotalAmountInPaise =
      visit.totalAmountInPaise + additionalAmountInPaise;
    const nextBillFinancials = visit.bill
      ? recomputeBillFinancialsForSubtotal(visit.bill, newTotalAmountInPaise)
      : null;
    const referralSnapshots = tests.map(
      (test) =>
        applyReferralRuleToPrices([test.priceInPaise], defaultReferralRule)[0],
    );
    const diagnosticCenterSnapshots = tests.map(
      (test) =>
        applyOptionalReferralRuleToPrices(
          [test.priceInPaise],
          defaultDiagnosticCenterRule,
        )[0],
    );

    // Create test orders with metadata snapshot in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create test orders with snapshotted metadata (E3-03)
      await tx.testOrder.createMany({
        data: tests.map((test, index) => ({
          visitId: visit.id,
          testId: test.id,
          branchId: req.branchId!,
          workflowMode: DiagnosticWorkflowMode.REPORTABLE,
          priceInPaise: test.priceInPaise,
          referralCommissionType: referralSnapshots[index].commissionType,
          referralCommissionPercentage:
            referralSnapshots[index].commissionPercentage,
          referralCommissionAmountInPaise:
            referralSnapshots[index].commissionAmountInPaise,
          diagnosticCenterCommissionType:
            diagnosticCenterSnapshots[index].commissionType,
          diagnosticCenterCommissionPercentage:
            diagnosticCenterSnapshots[index].commissionPercentage,
          diagnosticCenterCommissionAmountInPaise:
            diagnosticCenterSnapshots[index].commissionAmountInPaise,
          testNameSnapshot: test.name,
          testCodeSnapshot: test.code,
          referenceMinSnapshot: test.referenceMin,
          referenceMaxSnapshot: test.referenceMax,
          referenceUnitSnapshot: test.referenceUnit,
        })),
      });

      // Update visit total
      await tx.visit.update({
        where: { id },
        data: { totalAmountInPaise: newTotalAmountInPaise },
      });

      // Update bill total
      await tx.bill.updateMany({
        where: { visitId: id },
        data: {
          totalAmountInPaise: newTotalAmountInPaise,
          ...(nextBillFinancials
            ? {
                discountAmountInPaise: nextBillFinancials.discountAmountInPaise,
                paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
                paymentStatus: nextBillFinancials.paymentStatus,
              }
            : {}),
        },
      });

      return tx.visit.findUnique({
        where: { id },
        include: {
          testOrders: {
            include: { test: true },
          },
          bill: { include: { transactions: true } },
        },
      });
    });

    // Audit log for test addition
    await logAction({
      userId: req.user?.id!,
      actionType: "UPDATE",
      entityType: "VISIT",
      entityId: id,
      branchId: req.branchId!,
      oldValues: {
        testCount: existingTestIds.length,
        totalAmountInPaise: visit.totalAmountInPaise,
      },
      newValues: {
        testCount: result!.testOrders.length,
        totalAmountInPaise: newTotalAmountInPaise,
        addedTestIds: testIds,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.status(201).json({
      message: "Tests added successfully",
      addedCount: tests.length,
      newTotal: newTotalAmountInPaise / 100,
      testOrders: result!.testOrders.map((to) => ({
        id: to.id,
        testId: to.testId,
        testName: to.testNameSnapshot || to.test.name,
        testCode: to.testCodeSnapshot || to.test.code,
        price: to.priceInPaise / 100,
      })),
    });
  } catch (err: any) {
    console.error("Add tests to visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to add tests to visit",
    });
  }
});

// DELETE /api/visits/diagnostic/:id/tests/:testOrderId - Remove test from visit (E3-03)
// Tests can only be removed before report finalization
router.delete("/:id/tests/:testOrderId", async (req: AuthRequest, res) => {
  try {
    const { id, testOrderId } = req.params;

    // Get visit with report status
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        testOrders: {
          select: {
            id: true,
            visitId: true,
            testId: true,
            workflowMode: true,
            priceInPaise: true,
          },
        },
        bill: { include: { transactions: true } },
        report: {
          include: {
            versions: {
              where: { status: "FINALIZED" },
              take: 1,
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    // E3-03: Check if report is finalized
    const hasFinalized =
      visit.report?.versions && visit.report.versions.length > 0;
    if (hasFinalized) {
      return res.status(400).json({
        error: "REPORT_FINALIZED",
        message: "Cannot remove tests after report has been finalized",
      });
    }

    // Find the test order to remove
    const testOrder = visit.testOrders.find((to) => to.id === testOrderId);
    if (!testOrder) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Test order not found",
      });
    }

    // Must have at least one test remaining
    if (visit.testOrders.length <= 1) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Cannot remove the last test from a visit",
      });
    }

    // Block removal if it would leave the visit with no report-inclusion orders
    // (REPORTABLE or EXTERNAL_UPLOAD). A pure bill-only visit cannot reach the
    // result-entry/finalize flow that's already underway here.
    const targetIsReportInclusion =
      (testOrder.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE ||
      testOrder.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD;
    const reportInclusionOrderCount = visit.testOrders.filter(
      (order) =>
        (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
          DiagnosticWorkflowMode.REPORTABLE ||
        order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
    ).length;

    if (targetIsReportInclusion && reportInclusionOrderCount <= 1) {
      return res.status(400).json({
        error: "LAST_REPORTABLE_ORDER",
        message:
          "Cannot remove the last reportable / external-upload order from a diagnostic visit.",
      });
    }

    // Calculate new total
    const newTotalAmountInPaise =
      visit.totalAmountInPaise - testOrder.priceInPaise;
    let nextBillFinancials = null;
    try {
      nextBillFinancials = visit.bill
        ? recomputeBillFinancialsForSubtotal(visit.bill, newTotalAmountInPaise)
        : null;
    } catch (financialErr: any) {
      return res.status(400).json({
        error: "BILL_OVERPAID_AFTER_REMOVAL",
        message: financialErr.message,
      });
    }

    // Remove test order in a transaction
    await prisma.$transaction(async (tx) => {
      // Delete the test order
      await tx.testOrder.delete({
        where: { id: testOrderId },
      });

      // Update visit total
      await tx.visit.update({
        where: { id },
```
