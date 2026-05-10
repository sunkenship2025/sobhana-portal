# File: src/routes/diagnosticVisits.ts (Part 2)

Lines 851–1700 of 4146.

```ts
      const definitionPanelItem = order.testDefinitionId
        ? firstDefinitionPanelItemByDefinitionId.get(order.testDefinitionId)
        : undefined;

      return {
        ...order,
        test: {
          ...order.test,
          childTests: childTestsByParentId.get(order.testId) ?? [],
          panelItems: labPanelItem ? [labPanelItem] : [],
        },
        testDefinition: order.testDefinition
          ? {
              ...order.testDefinition,
              panelItems: definitionPanelItem ? [definitionPanelItem] : [],
            }
          : null,
      };
    });

    const visit = {
      ...visitBase,
      report: visitBase.report
        ? {
            id: visitBase.report.id,
            versions: reportVersions.map((version) => ({
              ...version,
              testResults: reportResultsByVersionId.get(version.id) ?? [],
            })),
          }
        : null,
      testOrders,
    };

    // Resolve age/gender-aware reference ranges for all tests (including child tests)
    const patient = visit.patient;
    const reportableOrders = getReportableOrders(visit.testOrders);
    const allTestIds: string[] = [];
    for (const to of reportableOrders) {
      allTestIds.push(to.testId);
      if (to.test.isPanel && to.test.childTests) {
        for (const ct of to.test.childTests) {
          allTestIds.push(ct.id);
        }
      }
    }
    const uniqueTestIds = [...new Set(allTestIds)];

    // Build testDefinitionId map from testOrders
    const testDefIdMap = new Map<string, string>();
    for (const to of reportableOrders) {
      if (to.testDefinitionId) {
        testDefIdMap.set(to.testId, to.testDefinitionId);
      }
    }

    const resolvedRanges = await resolveReferenceRanges(
      uniqueTestIds,
      patient.yearOfBirth,
      patient.gender as any,
      testDefIdMap.size > 0 ? testDefIdMap : undefined,
      patient.dateOfBirth,
    );

    const latestDefinitionFormulasByCode =
      await loadLatestDefinitionFormulasByCode(
        reportableOrders.flatMap((to) => [
          to.testCodeSnapshot || to.testDefinition?.code || to.test.code,
          ...to.test.childTests.map((child) => child.code),
        ]),
      );

    // Bulk-fetch entry-time input configs (presets, default value, input type)
    // for every test in this visit. Keyed by rootDefinitionId.
    const rootIdsToFetch = new Set<string>();
    for (const to of reportableOrders) {
      if (to.testDefinition?.rootDefinitionId) {
        rootIdsToFetch.add(to.testDefinition.rootDefinitionId);
      }
      // For legacy panel children, look up by code to find the latest TestDefinition's rootId
      for (const child of to.test.childTests) {
        const latestForChild = latestDefinitionFormulasByCode.get(child.code);
        if (latestForChild?.rootDefinitionId) {
          rootIdsToFetch.add(latestForChild.rootDefinitionId);
        }
      }
    }
    const inputConfigsByRootId = await loadInputConfigsByRootId(rootIdsToFetch);

    // Helper to build referenceRange from resolved + fallback data
    const buildRange = (
      testId: string,
      defaultMin: number | null,
      defaultMax: number | null,
      defaultUnit: string | null,
      defaultText?: string | null,
    ) => {
      const resolved = resolvedRanges.get(testId);
      return {
        min: resolved?.referenceMin ?? defaultMin ?? 0,
        max: resolved?.referenceMax ?? defaultMax ?? 0,
        unit: resolved?.referenceUnit || defaultUnit || "",
        text: defaultText || "",
      };
    };
    // Transform to frontend format
    const latestFinalizedVersion =
      visit.report?.versions.find(
        (version: any) => version.status === "FINALIZED",
      ) || null;
    const composition = getVisitComposition(
      visit.testOrders,
      visit.status,
      visit.report?.versions || [],
    );
    const billFinancials = buildBillFinancialResponse(visit.bill);

    const transformed = {
      id: visit.id,
      branchId: visit.branchId,
      billNumber: visit.billNumber,
      patientId: visit.patientId,
      patient: visit.patient,
      domain: visit.domain,
      status: visit.status,
      totalAmount: visit.totalAmountInPaise / 100,
      paymentType:
        Array.isArray((visit as any).bill?.transactions) &&
        (visit as any).bill.transactions.length > 0
          ? Array.from(
              new Set(
                (visit as any).bill.transactions.map((t: any) => t.paymentType),
              ),
            ).join(", ")
          : null,
      paymentStatus: visit.bill?.paymentStatus || "PENDING",
      ...billFinancials,
      billedAt: visit.bill?.billedAt || visit.bill?.createdAt || null,
      reportFinalizedAt: latestFinalizedVersion?.finalizedAt || null,
      hasReportableOrders: composition.hasReportableOrders,
      hasBillOnlyOrders: composition.hasBillOnlyOrders,
      hasExternalUploadOrders: composition.hasExternalUploadOrders,
      hasReportInclusionOrders: composition.hasReportInclusionOrders,
      hasEntryScreenOrders: composition.hasEntryScreenOrders,
      hasFinalizedReport: composition.hasFinalizedReport,
      nextAction: composition.nextAction,
      referralDoctorId: visit.referrals[0]?.referralDoctorId || null,
      referralDoctor: visit.referrals[0]?.referralDoctor || null,
      testOrders: visit.testOrders.map((to) => {
        const orderCode =
          to.testCodeSnapshot || to.testDefinition?.code || to.test.code;
        const latestOrderDefinition =
          latestDefinitionFormulasByCode.get(orderCode);
        const orderDerived = to.testDefinition?.formulaExpression
          ? buildDerivedMetadata(
              to.testDefinition.formulaExpression,
              to.testDefinition.dependsOnCodes,
            )
          : to.test.derivedParameter?.formula
            ? buildDerivedMetadata(
                to.test.derivedParameter.formula,
                to.test.derivedParameter.dependsOnTestCodes,
              )
            : buildDerivedMetadata(
                latestOrderDefinition?.formulaExpression,
                latestOrderDefinition?.dependsOnCodes,
              );

        const orderRootId =
          to.testDefinition?.rootDefinitionId ?? latestOrderDefinition?.rootDefinitionId;
        const orderInputConfig =
          (orderRootId && inputConfigsByRootId.get(orderRootId)) || DEFAULT_INPUT_CONFIG;

        return {
          id: to.id,
          visitId: to.visitId,
          testId: to.testId,
          productId: to.productId,
          testDefinitionId: to.testDefinitionId,
          workflowMode: to.workflowMode,
          testName: to.testNameSnapshot || to.test.name,
          testCode: to.testCodeSnapshot || to.test.code,
          price: to.priceInPaise / 100,
          priceInPaise: to.priceInPaise,
          referralCommissionType: to.referralCommissionType,
          referralCommissionPercent: to.referralCommissionPercentage,
          referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
          isPanel: to.test.isPanel,
          isDerived: orderDerived.isDerived,
          formulaExpression: orderDerived.formulaExpression,
          dependsOnCodes: orderDerived.dependsOnCodes,
          inputConfig: orderInputConfig,
          department: (() => {
            const dept =
              to.testDefinition?.panelItems?.[0]?.panel?.department ||
              to.test.panelItems?.[0]?.panel?.department ||
              to.testDefinition?.department ||
              to.test.department;
            return dept ? { id: dept.id, name: dept.name } : null;
          })(),
          panel: (() => {
            const panel =
              to.testDefinition?.panelItems?.[0]?.panel ||
              to.test.panelItems?.[0]?.panel ||
              null;
            const panelMethodText =
              panel && "panelMethodText" in panel
                ? (panel.panelMethodText ?? null)
                : null;
            const panelMethodItalic =
              panel && "panelMethodItalic" in panel
                ? (panel.panelMethodItalic ?? false)
                : false;
            const narrativeTemplateHtml =
              panel && "narrativeTemplateHtml" in panel
                ? (panel.narrativeTemplateHtml ?? null)
                : null;
            return panel
              ? {
                  id: panel.id,
                  name: panel.name,
                  displayName: panel.displayName,
                  layoutType: panel.layoutType,
                  panelMethodText,
                  panelMethodItalic,
                  narrativeTemplateHtml,
                }
              : null;
          })(),
          referenceRange: buildRange(
            to.testId,
            to.referenceMinSnapshot ??
              to.testDefinition?.referenceMin ??
              to.test.referenceMin,
            to.referenceMaxSnapshot ??
              to.testDefinition?.referenceMax ??
              to.test.referenceMax,
            to.referenceUnitSnapshot ||
              to.testDefinition?.referenceUnit ||
              to.test.referenceUnit,
            to.testDefinition?.referenceText || to.test.referenceText,
          ),
          childTests: to.test.isPanel
            ? to.test.childTests.map((ct: any) => {
                const latestChildDefinition =
                  latestDefinitionFormulasByCode.get(ct.code);
                const childDerived = buildDerivedMetadata(
                  ct.derivedParameter?.formula ||
                    latestChildDefinition?.formulaExpression,
                  ct.derivedParameter?.dependsOnTestCodes ||
                    latestChildDefinition?.dependsOnCodes,
                );
                const childRootId = latestChildDefinition?.rootDefinitionId;
                const childInputConfig =
                  (childRootId && inputConfigsByRootId.get(childRootId)) ||
                  DEFAULT_INPUT_CONFIG;

                return {
                  id: ct.id,
                  name: ct.name,
                  code: ct.code,
                  displayOrder: ct.displayOrder,
                  isDerived: childDerived.isDerived,
                  formulaExpression: childDerived.formulaExpression,
                  dependsOnCodes: childDerived.dependsOnCodes,
                  inputConfig: childInputConfig,
                  referenceRange: buildRange(
                    ct.id,
                    ct.referenceMin,
                    ct.referenceMax,
                    ct.referenceUnit,
                    ct.referenceText,
                  ),
                };
              })
            : [],
          results: to.testResults.map((tr: any) => ({
            ...tr,
            manualOverride: isManualDerivedOverrideNote(tr.notes),
            testName: tr.test?.name || "",
            testCode: tr.test?.code || "",
            referenceRange: buildRange(
              tr.testId,
              tr.test?.referenceMin,
              tr.test?.referenceMax,
              tr.test?.referenceUnit,
              tr.test?.referenceText,
            ),
          })),
        };
      }),
      billItems: buildDiagnosticBillItems(
        visit.testOrders.map((to) => ({
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
          referralCommissionType: visit.referrals[0]?.referralDoctor
            ? to.referralCommissionType
            : undefined,
          referralCommissionPercentage: visit.referrals[0]?.referralDoctor
            ? to.referralCommissionPercentage
            : undefined,
          referralCommissionAmountInPaise: visit.referrals[0]?.referralDoctor
            ? to.referralCommissionAmountInPaise
            : undefined,
        })),
      ),
      report: visit.report
        ? {
            id: visit.report.id,
            versions: visit.report.versions.map((v: any) => ({
              id: v.id,
              versionNumber: v.versionNum,
              status: v.status,
              finalizedAt: v.finalizedAt,
              testResults: v.testResults.map((tr: any) => ({
                ...tr,
                manualOverride: isManualDerivedOverrideNote(tr.notes),
                testName: tr.test?.name || "",
                testCode: tr.test?.code || "",
                referenceRange: buildRange(
                  tr.testId,
                  tr.test?.referenceMin,
                  tr.test?.referenceMax,
                  tr.test?.referenceUnit,
                  tr.test?.referenceText,
                ),
              })),
            })),
          }
        : null,
      createdAt: visit.createdAt,
      updatedAt: visit.updatedAt,
    };

    return res.json(transformed);
  } catch (err: any) {
    console.error("Get diagnostic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to get diagnostic visit",
    });
  }
});

// POST /api/visits/diagnostic - Create new diagnostic visit
// Accepts EITHER productIds (new architecture) OR testIds (legacy)
router.post("/", async (req: AuthRequest, res) => {
  try {
    const {
      patientId,
      referralDoctorId,
      diagnosticCenterId,
      referralOverrides,
      diagnosticCenterOverrides,
      testIds,
      productIds,
      paymentType,
      discountType,
      discountValue,
      discountReason,
      paidAmount,
      payments,
      sendWhatsApp,
    } = req.body;

    const hasProducts =
      productIds && Array.isArray(productIds) && productIds.length > 0;
    const hasTests = testIds && Array.isArray(testIds) && testIds.length > 0;

    // Validation
    if (!patientId || (!hasProducts && !hasTests)) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Patient ID and at least one product or test are required",
      });
    }

    if (discountType && discountType !== "NONE" && discountValue > 0 && !discountReason?.trim()) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "A reason must be provided when applying a discount",
      });
    }

    // Get branch code for bill number
    const branch = await prisma.branch.findUnique({
      where: { id: req.branchId },
    });

    if (!branch) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Invalid branch",
      });
    }

    let defaultReferralRule: NormalizedReferralPayout | null = null;
    const referralRuleByProductId = new Map<string, NormalizedReferralPayout>();
    let defaultDiagnosticCenterRule: NormalizedReferralPayout | null = null;
    const diagnosticCenterRuleByProductId = new Map<
      string,
      NormalizedReferralPayout
    >();

    if (referralDoctorId) {
      const referralDoc = await prisma.referralDoctor.findUnique({
        where: { id: referralDoctorId },
        include: {
          productRules: {
            where: { isActive: true },
          },
        },
      });

      if (!referralDoc) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Referral doctor not found",
        });
      }

      defaultReferralRule = {
        commissionType: referralDoc.commissionType,
        commissionPercent: referralDoc.commissionPercent,
        commissionAmountInPaise: referralDoc.commissionAmountInPaise,
      };

      for (const rule of referralDoc.productRules) {
        referralRuleByProductId.set(rule.productId, {
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
        });
      }
    }

    if (diagnosticCenterId) {
      const diagnosticCenter = await prisma.diagnosticReferralCenter.findUnique(
        {
          where: { id: diagnosticCenterId },
          include: {
            productRules: {
              where: { isActive: true },
            },
          },
        },
      );

      if (!diagnosticCenter) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Diagnostic center not found",
        });
      }

      defaultDiagnosticCenterRule = {
        commissionType: diagnosticCenter.commissionType,
        commissionPercent: diagnosticCenter.commissionPercent,
        commissionAmountInPaise: diagnosticCenter.commissionAmountInPaise,
      };

      for (const rule of diagnosticCenter.productRules) {
        diagnosticCenterRuleByProductId.set(rule.productId, {
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
        });
      }
    }

    const overrides = new Map<string, NormalizedReferralPayout>();
    const diagnosticCenterOverrideMap = new Map<
      string,
      NormalizedReferralPayout
    >();
    if (referralOverrides && typeof referralOverrides === "object") {
      try {
        for (const [key, value] of Object.entries(referralOverrides)) {
          const normalized = normalizeReferralOverrideInput(value);
          if (normalized) {
            overrides.set(key, normalized);
          }
        }
      } catch (validationErr: any) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: validationErr.message,
        });
      }
    }

    if (
      diagnosticCenterOverrides &&
      typeof diagnosticCenterOverrides === "object"
    ) {
      try {
        for (const [key, value] of Object.entries(diagnosticCenterOverrides)) {
          const normalized = normalizeReferralOverrideInput(value);
          if (normalized) {
            diagnosticCenterOverrideMap.set(key, normalized);
          }
        }
      } catch (validationErr: any) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: validationErr.message,
        });
      }
    }

    // ── Resolve tests + pricing ──
    // Two paths: product-based (new) or direct test-based (legacy)
    let totalAmountInPaise = 0;
    let testOrderData: Array<{
      testId: string;
      testDefinitionId?: string;
      productId?: string;
      workflowMode: DiagnosticWorkflowMode;
      priceInPaise: number;
      testNameSnapshot: string;
      testCodeSnapshot: string;
      referenceMinSnapshot: number | null;
      referenceMaxSnapshot: number | null;
      referenceUnitSnapshot: string | null;
      referralCommissionType: "PERCENTAGE" | "FIXED_AMOUNT";
      referralCommissionPercentage: number | null;
      referralCommissionAmountInPaise: number | null;
      diagnosticCenterCommissionType: "PERCENTAGE" | "FIXED_AMOUNT" | null;
      diagnosticCenterCommissionPercentage: number | null;
      diagnosticCenterCommissionAmountInPaise: number | null;
    }> = [];

    if (hasProducts) {
      // ── New architecture: resolve BillableProducts ──
      try {
        const resolved = await resolveProducts(productIds, req.branchId!);

        for (const rp of resolved) {
          const effectiveRule =
            overrides.get(rp.productId) ??
            referralRuleByProductId.get(rp.productId) ??
            defaultReferralRule;
          const effectiveDiagnosticCenterRule =
            diagnosticCenterOverrideMap.get(rp.productId) ??
            diagnosticCenterRuleByProductId.get(rp.productId) ??
            defaultDiagnosticCenterRule;
          const referralSnapshots = applyReferralRuleToPrices(
            rp.testOrders.map((to) => to.priceInPaise),
            effectiveRule,
          );
          const diagnosticCenterSnapshots = applyOptionalReferralRuleToPrices(
            rp.testOrders.map((to) => to.priceInPaise),
            effectiveDiagnosticCenterRule,
          );

          for (const [index, to] of rp.testOrders.entries()) {
            testOrderData.push({
              testId: to.labTestId,
              testDefinitionId: to.testDefinitionId,
              productId: to.productId,
              workflowMode: to.workflowMode,
              priceInPaise: to.priceInPaise,
              testNameSnapshot: to.testName,
              testCodeSnapshot: to.testCode,
              referenceMinSnapshot: to.referenceMin,
              referenceMaxSnapshot: to.referenceMax,
              referenceUnitSnapshot: to.referenceUnit,
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
            });
          }
          totalAmountInPaise += rp.effectivePrice;
        }
      } catch (err) {
        if (err instanceof ProductResolutionError) {
          return res.status(400).json({
            error: err.code,
            message: err.message,
            details: err.details,
          });
        }
        throw err;
      }
    } else {
      // ── Legacy path: direct LabTest IDs ──
      const tests = await prisma.labTest.findMany({
        where: { id: { in: testIds } },
      });

      if (tests.length !== testIds.length) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "One or more tests not found",
        });
      }

      totalAmountInPaise = tests.reduce((sum, t) => sum + t.priceInPaise, 0);

      testOrderData = tests.map((test) => {
        const effectiveRule = overrides.get(test.id) ?? defaultReferralRule;
        const referralSnapshot = applyReferralRuleToPrices(
          [test.priceInPaise],
          effectiveRule,
        )[0];
        const diagnosticCenterSnapshot = applyOptionalReferralRuleToPrices(
          [test.priceInPaise],
          diagnosticCenterOverrideMap.get(test.id) ??
            defaultDiagnosticCenterRule,
        )[0];

        return {
          testId: test.id,
          workflowMode: DiagnosticWorkflowMode.REPORTABLE,
          priceInPaise: test.priceInPaise,
          testNameSnapshot: test.name,
          testCodeSnapshot: test.code,
          referenceMinSnapshot: test.referenceMin,
          referenceMaxSnapshot: test.referenceMax,
          referenceUnitSnapshot: test.referenceUnit,
          referralCommissionType: referralSnapshot.commissionType,
          referralCommissionPercentage: referralSnapshot.commissionPercentage,
          referralCommissionAmountInPaise:
            referralSnapshot.commissionAmountInPaise,
          diagnosticCenterCommissionType:
            diagnosticCenterSnapshot.commissionType,
          diagnosticCenterCommissionPercentage:
            diagnosticCenterSnapshot.commissionPercentage,
          diagnosticCenterCommissionAmountInPaise:
            diagnosticCenterSnapshot.commissionAmountInPaise,
        };
      });
    }

    if (testOrderData.length === 0) {
      return res.status(400).json({
        error: "INVALID_PANEL_CONFIGURATION",
        message:
          "The selected product does not contain any reportable test items. Please fix the linked panel configuration.",
      });
    }

    let billFinancials;
    try {
      billFinancials = normalizeBillFinancialInput(
        {
          totalAmountInPaise,
          discountType,
          discountValue,
          discountReason,
          paidAmount,
        },
        { defaultPaidToNet: true },
      );
    } catch (validationErr: any) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: validationErr.message,
      });
    }

    const createComposition = getVisitComposition(
      testOrderData,
      VisitStatus.WAITING,
    );
    // Visits that require an entry screen (REPORTABLE values OR external uploads)
    // start as DRAFT and only complete after finalize. Pure bill-only visits skip
    // straight to COMPLETED because there's nothing to enter.
    const initialVisitStatus = createComposition.hasReportInclusionOrders
      ? VisitStatus.DRAFT
      : VisitStatus.COMPLETED;

    // Generate bill number
    const billNumber = await generateDiagnosticBillNumber(branch.code);

    // Create visit with all related records in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // Create visit
        const visit = await tx.visit.create({
          data: {
            branchId: req.branchId!,
            patientId,
            domain: "DIAGNOSTICS",
            status: initialVisitStatus,
            billNumber,
            totalAmountInPaise,
          },
        });

        // Create bill
        await tx.bill.create({
          data: {
            visitId: visit.id,
            billNumber,
            branchId: req.branchId!,
            totalAmountInPaise,
            discountReason: billFinancials.discountReason,
            discountType: billFinancials.discountType,
            discountPercentage: billFinancials.discountPercentage,
            discountAmountInPaise: billFinancials.discountAmountInPaise,
            paidAmountInPaise: billFinancials.paidAmountInPaise,
            paymentStatus: billFinancials.paymentStatus,
            transactions:
              billFinancials.paidAmountInPaise > 0
                ? {
                    create:
                      Array.isArray(payments) && payments.length > 0
                        ? payments.map((p: any) => ({
                            amountInPaise:
                              p.amountInPaise ??
                              Math.round((p.amount || 0) * 100),
                            paymentType: p.paymentType ?? p.type ?? "CASH",
                            collectedByUserId: req.user!.id,
                          }))
                        : [
                            {
                              amountInPaise: billFinancials.paidAmountInPaise,
                              paymentType: paymentType || "CASH",
                              collectedByUserId: req.user!.id,
                            },
                          ],
                  }
                : undefined,
          },
        });

        // Create referral if specified
        if (referralDoctorId) {
          await tx.referralDoctor_Visit.create({
            data: {
              visitId: visit.id,
              referralDoctorId,
              branchId: req.branchId!,
            },
          });
        }

        // Create diagnostic center referral if specified
        if (diagnosticCenterId) {
          await tx.diagnosticCenter_Visit.create({
            data: {
              visitId: visit.id,
              diagnosticCenterId,
              referralType: "REFERRED_FROM",
              branchId: req.branchId!,
            },
          });
        }

        if (referralDoctorId && hasProducts && overrides.size > 0) {
          for (const productId of productIds.filter((id: string) =>
            overrides.has(id),
          )) {
            const override = overrides.get(productId);
            if (!override) continue;

            if (areReferralPayoutsEqual(override, defaultReferralRule)) {
              await tx.referralDoctorProductRule.deleteMany({
                where: {
                  referralDoctorId,
                  productId,
                },
              });
              continue;
            }

            await tx.referralDoctorProductRule.upsert({
              where: {
                referralDoctorId_productId: {
                  referralDoctorId,
                  productId,
                },
              },
              update: {
                commissionType: override.commissionType,
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
                isActive: true,
              },
              create: {
                referralDoctorId,
                productId,
                commissionType: override.commissionType,
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
                isActive: true,
              },
            });
          }
        }

        if (
          diagnosticCenterId &&
          hasProducts &&
          diagnosticCenterOverrideMap.size > 0
        ) {
          for (const productId of productIds.filter((id: string) =>
            diagnosticCenterOverrideMap.has(id),
          )) {
            const override = diagnosticCenterOverrideMap.get(productId);
            if (!override) continue;

            if (
              areReferralPayoutsEqual(override, defaultDiagnosticCenterRule)
            ) {
              await tx.diagnosticCenterProductRule.deleteMany({
                where: {
                  diagnosticCenterId,
                  productId,
                },
              });
              continue;
            }

            await tx.diagnosticCenterProductRule.upsert({
              where: {
                diagnosticCenterId_productId: {
                  diagnosticCenterId,
                  productId,
                },
              },
              update: {
                commissionType: override.commissionType,
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
                isActive: true,
              },
              create: {
                diagnosticCenterId,
                productId,
                commissionType: override.commissionType,
```
