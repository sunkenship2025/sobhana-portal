# File: src/routes/diagnosticVisits.ts (Part 4)

Lines 2551–3400 of 4146.

```ts
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
    });

    // Audit log for test removal
    await logAction({
      userId: req.user?.id!,
      actionType: "UPDATE",
      entityType: "VISIT",
      entityId: id,
      branchId: req.branchId!,
      oldValues: {
        testCount: visit.testOrders.length,
        totalAmountInPaise: visit.totalAmountInPaise,
      },
      newValues: {
        testCount: visit.testOrders.length - 1,
        totalAmountInPaise: newTotalAmountInPaise,
        removedTestOrderId: testOrderId,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.json({
      message: "Test removed successfully",
      newTotal: newTotalAmountInPaise / 100,
    });
  } catch (err: any) {
    console.error("Remove test from visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to remove test from visit",
    });
  }
});

// POST /api/visits/diagnostic/:id/results - Save test results
router.post("/:id/results", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { results } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Results array is required",
      });
    }

    // Get visit with report and test orders with their test (including children for panels)
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        report: {
          include: {
            versions: {
              where: { status: "DRAFT" },
              orderBy: { versionNum: "desc" },
              take: 1,
            },
          },
        },
        testOrders: {
          include: {
            test: {
              include: {
                derivedParameter: {
                  select: {
                    parameterName: true,
                    formula: true,
                    dependsOnTestCodes: true,
                  },
                },
                childTests: {
                  include: {
                    derivedParameter: {
                      select: {
                        parameterName: true,
                        formula: true,
                        dependsOnTestCodes: true,
                      },
                    },
                  },
                }, // Include child tests for panels
              },
            },
            testDefinition: {
              select: {
                id: true,
                code: true,
                name: true,
                displayOrder: true,
                formulaExpression: true,
                dependsOnCodes: true,
              },
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

    // Allow result entry whenever the visit has anything that lands on the
    // entry screen (REPORTABLE values OR EXTERNAL_UPLOAD attachments).
    if (getReportInclusionOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not use result entry.",
      });
    }
    const reportableOrders = getReportableOrders(visit.testOrders);

    const draftVersion = visit.report?.versions[0];
    if (!draftVersion) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "No draft report version found",
      });
    }

    const manualDerivedOverrideTestIds = new Set<string>(
      results
        .filter(
          (result: any) => result?.manualOverride === true && result?.testId,
        )
        .map((result: any) => result.testId),
    );

    // Build a map: testId -> testOrderId (includes sub-tests)
    const testToOrderMap = new Map<string, string>();
    // Build a map: testId -> testDefinitionId (from testOrder, for new-arch linking)
    const testToDefIdMap = new Map<string, string>();
    for (const testOrder of reportableOrders) {
      // Map the ordered test itself
      testToOrderMap.set(testOrder.testId, testOrder.id);
      if (testOrder.testDefinitionId) {
        testToDefIdMap.set(testOrder.testId, testOrder.testDefinitionId);
      }
      // For panels, also map all child tests to the parent order
      if (testOrder.test.isPanel && testOrder.test.childTests) {
        for (const childTest of testOrder.test.childTests) {
          testToOrderMap.set(childTest.id, testOrder.id);
        }
      }
    }

    // Upsert test results
    await prisma.$transaction(async (tx) => {
      for (const result of results) {
        const testOrderId = testToOrderMap.get(result.testId);
        if (!testOrderId) {
          console.warn(`No test order found for testId: ${result.testId}`);
          continue;
        }

        // Delete existing result for this specific testId (not just testOrderId)
        await tx.testResult.deleteMany({
          where: {
            testOrderId,
            testId: result.testId,
            reportVersionId: draftVersion.id,
          },
        });

        // Create new result (either numeric value, textValue, or text notes)
        if (
          (result.value !== null && result.value !== undefined) ||
          result.textValue ||
          (result.notes && result.notes.trim())
        ) {
          const numericValue =
            result.value != null ? parseFloat(result.value) : NaN;
          const isText = isNaN(numericValue);
          const defId = testToDefIdMap.get(result.testId) ?? null;
          const normalizedNotes = manualDerivedOverrideTestIds.has(
            result.testId,
          )
            ? DERIVED_MANUAL_OVERRIDE_NOTE
            : result.notes || null;
          // Prefer explicit textValue from frontend; fall back to notes for legacy clients
          const textVal =
            result.textValue ||
            (isText ? normalizedNotes || String(result.value ?? "") : null);
          await tx.testResult.create({
            data: {
              testOrderId,
              testId: result.testId,
              reportVersionId: draftVersion.id,
              value: isText ? null : numericValue,
              textValue: textVal || null,
              flag: result.flag || null,
              notes: normalizedNotes,
              testDefinitionId: defId,
            },
          });
        }
      }

      // Update visit status to WAITING if still DRAFT or IN_PROGRESS
      if (visit.status === "DRAFT" || visit.status === "IN_PROGRESS") {
        await tx.visit.update({
          where: { id },
          data: { status: "WAITING" },
        });
      }
    });

    // --- Auto-flag results with age-aware reference ranges ---
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: visit.patientId },
        select: { yearOfBirth: true, dateOfBirth: true, gender: true },
      });

      if (patient) {
        // Collect test IDs that had numeric values
        const flaggableResults = results.filter(
          (r: any) => r.value !== null && r.value !== undefined && r.testId,
        );
        const testIdsForFlags = flaggableResults.map((r: any) => r.testId);

        if (testIdsForFlags.length > 0) {
          const resolvedRanges = await resolveReferenceRanges(
            testIdsForFlags,
            patient.yearOfBirth,
            patient.gender as any,
            undefined,
            patient.dateOfBirth,
          );

          // Batch-update flags based on resolved ranges
          for (const r of flaggableResults) {
            const range = resolvedRanges.get(r.testId);
            if (!range) continue;

            const numValue = parseFloat(r.value);
            if (isNaN(numValue)) continue;

            const flag = determineResultFlag(numValue, range);

            if (flag) {
              const testOrderId = testToOrderMap.get(r.testId);
              if (testOrderId) {
                await prisma.testResult.updateMany({
                  where: {
                    testOrderId,
                    testId: r.testId,
                    reportVersionId: draftVersion.id,
                  },
                  data: { flag },
                });
              }
            }
          }
        }
      }
    } catch (flagErr) {
      // Non-fatal: log but don't fail the whole request
      console.warn("Auto-flag calculation warning:", flagErr);
    }

    // --- Derived Parameters: auto-calculate formula-based values ---
    try {
      const latestDefinitionFormulasByCode =
        await loadLatestDefinitionFormulasByCode(
          reportableOrders.flatMap((testOrder) => [
            testOrder.testDefinition?.code ||
              testOrder.testCodeSnapshot ||
              testOrder.test.code,
            ...testOrder.test.childTests.map((child) => child.code),
          ]),
        );

      const resultsByTestCode = new Map<string, number>();
      for (const r of results) {
        if (r.value === null || r.value === undefined) continue;

        const numericValue = parseFloat(r.value);
        if (isNaN(numericValue)) continue;

        const testOrder = reportableOrders.find(
          (order) => order.testId === r.testId,
        );
        if (testOrder) {
          resultsByTestCode.set(
            testOrder.testDefinition?.code ||
              testOrder.testCodeSnapshot ||
              testOrder.test.code,
            numericValue,
          );
          continue;
        }

        for (const order of reportableOrders) {
          const childTest = order.test.childTests.find(
            (child) => child.id === r.testId,
          );
          if (childTest) {
            resultsByTestCode.set(childTest.code, numericValue);
            break;
          }
        }
      }

      const derivedTargets: DerivedFormulaTarget[] = [];
      for (const testOrder of reportableOrders) {
        const orderCode =
          testOrder.testDefinition?.code ||
          testOrder.testCodeSnapshot ||
          testOrder.test.code;
        const latestOrderDefinition =
          latestDefinitionFormulasByCode.get(orderCode);
        const orderDerived = testOrder.testDefinition?.formulaExpression
          ? buildDerivedMetadata(
              testOrder.testDefinition.formulaExpression,
              testOrder.testDefinition.dependsOnCodes,
            )
          : testOrder.test.derivedParameter?.formula
            ? buildDerivedMetadata(
                testOrder.test.derivedParameter.formula,
                testOrder.test.derivedParameter.dependsOnTestCodes,
              )
            : buildDerivedMetadata(
                latestOrderDefinition?.formulaExpression,
                latestOrderDefinition?.dependsOnCodes,
              );

        if (
          orderDerived.isDerived &&
          orderDerived.formulaExpression &&
          orderDerived.dependsOnCodes
        ) {
          derivedTargets.push({
            testId: testOrder.testId,
            testDefinitionId: testOrder.testDefinitionId ?? null,
            code: orderCode,
            parameterName:
              testOrder.testDefinition?.name ||
              testOrder.test.derivedParameter?.parameterName ||
              latestOrderDefinition?.name ||
              testOrder.testNameSnapshot ||
              testOrder.test.name,
            formula: orderDerived.formulaExpression,
            dependsOnCodes: orderDerived.dependsOnCodes,
            displayOrder:
              testOrder.testDefinition?.displayOrder ??
              latestOrderDefinition?.displayOrder ??
              testOrder.test.displayOrder ??
              0,
          });
        }

        for (const childTest of testOrder.test.childTests) {
          const latestChildDefinition = latestDefinitionFormulasByCode.get(
            childTest.code,
          );
          const childDerived = buildDerivedMetadata(
            childTest.derivedParameter?.formula ||
              latestChildDefinition?.formulaExpression,
            childTest.derivedParameter?.dependsOnTestCodes ||
              latestChildDefinition?.dependsOnCodes,
          );

          if (
            childDerived.isDerived &&
            childDerived.formulaExpression &&
            childDerived.dependsOnCodes
          ) {
            derivedTargets.push({
              testId: childTest.id,
              testDefinitionId: null,
              code: childTest.code,
              parameterName:
                childTest.derivedParameter?.parameterName ||
                latestChildDefinition?.name ||
                childTest.name,
              formula: childDerived.formulaExpression,
              dependsOnCodes: childDerived.dependsOnCodes,
              displayOrder:
                latestChildDefinition?.displayOrder ??
                childTest.displayOrder ??
                0,
            });
          }
        }
      }

      const derivedResults = evaluateDerivedTargets(
        derivedTargets,
        resultsByTestCode,
      );

      if (derivedResults.length > 0) {
        const draftVer = visit.report?.versions[0];
        if (draftVer) {
          const patient = await prisma.patient.findUnique({
            where: { id: visit.patientId },
            select: { yearOfBirth: true, dateOfBirth: true, gender: true },
          });

          const derivedTestIds = derivedResults
            .filter((dr) => dr.value !== null)
            .map((dr) => dr.testId);

          const derivedRanges =
            patient && derivedTestIds.length > 0
              ? await resolveReferenceRanges(
                  derivedTestIds,
                  patient.yearOfBirth,
                  patient.gender as any,
                  testToDefIdMap.size > 0 ? testToDefIdMap : undefined,
                  patient.dateOfBirth,
                )
              : new Map();

          for (const dr of derivedResults) {
            const orderIdForDerived = testToOrderMap.get(dr.testId);
            if (!orderIdForDerived) continue;

            if (manualDerivedOverrideTestIds.has(dr.testId)) {
              continue;
            }

            // Upsert derived result
            await prisma.testResult.deleteMany({
              where: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
              },
            });

            if (dr.value === null) {
              continue;
            }

            const derivedRange = derivedRanges.get(dr.testId);
            const derivedFlag = derivedRange
              ? determineResultFlag(dr.value, derivedRange)
              : null;

            await prisma.testResult.create({
              data: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
                value: dr.value,
                flag: derivedFlag,
                notes: `${DERIVED_AUTO_NOTE_PREFIX}${dr.parameterName}`,
                testDefinitionId:
                  dr.testDefinitionId ?? testToDefIdMap.get(dr.testId) ?? null,
              },
            });
          }

          for (const manualTestId of manualDerivedOverrideTestIds) {
            const manualInput = results.find(
              (result: any) => result.testId === manualTestId,
            );
            const manualOrderId = testToOrderMap.get(manualTestId);

            if (!manualInput || !manualOrderId) {
              continue;
            }

            const numericValue =
              manualInput.value !== null && manualInput.value !== undefined
                ? parseFloat(manualInput.value)
                : NaN;

            await prisma.testResult.deleteMany({
              where: {
                testOrderId: manualOrderId,
                testId: manualTestId,
                reportVersionId: draftVer.id,
              },
            });

            if (isNaN(numericValue)) {
              continue;
            }

            const manualRange = derivedRanges.get(manualTestId);
            const manualFlag = manualRange
              ? determineResultFlag(numericValue, manualRange)
              : null;

            await prisma.testResult.create({
              data: {
                testOrderId: manualOrderId,
                testId: manualTestId,
                reportVersionId: draftVer.id,
                value: numericValue,
                flag: manualFlag,
                notes: DERIVED_MANUAL_OVERRIDE_NOTE,
                testDefinitionId: testToDefIdMap.get(manualTestId) ?? null,
              },
            });
          }
        }
      }
    } catch (derivedErr) {
      // Non-fatal: log but don't fail the whole request
      console.warn("Derived parameter calculation warning:", derivedErr);
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error("Save test results error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to save test results",
    });
  }
});

// POST /api/visits/diagnostic/:id/collect-sample - Record sample collection and decrement stock
router.post("/:id/collect-sample", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;
    const userId = req.user!.id;

    // Fetch visit with test orders
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        testOrders: {
          include: {
            test: {
              select: {
                id: true,
                name: true,
                sampleType: true,
                isPanel: true,
                childTests: { select: { id: true } },
              },
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

    const reportableOrders = getReportableOrders(visit.testOrders);
    if (reportableOrders.length === 0) {
      return res.json({
        success: true,
        status: visit.status,
        testsCollected: visit.testOrders.length,
        sampleTypes: [
          ...new Set(
            visit.testOrders.map((to) => to.test.sampleType).filter(Boolean),
          ),
        ],
        collectedAt: visit.createdAt,
      });
    }

    if (visit.status !== "DRAFT") {
      return res.status(400).json({
        error: "INVALID_STATUS",
        message: `Sample can only be collected when visit is in DRAFT status. Current status: ${visit.status}`,
      });
    }

    // Collect all test IDs (including panel children)
    const testIds: string[] = [];
    for (const to of reportableOrders) {
      testIds.push(to.testId);
      if (to.test.isPanel && to.test.childTests) {
        for (const child of to.test.childTests) {
          testIds.push(child.id);
        }
      }
    }

    // Update status in a transaction
    await prisma.$transaction(async (tx) => {
      // Move visit to IN_PROGRESS
      await tx.visit.update({
        where: { id },
        data: { status: "IN_PROGRESS" },
      });
    });

    // Audit log
    await logAction({
      actionType: "FINALIZE",
      entityType: "Visit",
      entityId: id,
      userId,
      branchId,
      newValues: {
        billNumber: visit.billNumber,
        testCount: testIds.length,
        sampleTypes: [
          ...new Set(
            reportableOrders
              .map((to: any) => to.test.sampleType)
              .filter(Boolean),
          ),
        ],
      },
    });

    return res.json({
      success: true,
      status: "IN_PROGRESS",
      testsCollected: testIds.length,
      sampleTypes: [
        ...new Set(
          reportableOrders.map((to) => to.test.sampleType).filter(Boolean),
        ),
      ],
    });
  } catch (err: any) {
    console.error("Collect sample error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to record sample collection",
    });
  }
});

// GET /api/visits/diagnostic/:id/report-snapshot - JSON snapshot for grouped screen preview
// Returns finalized frozen snapshot when available, otherwise a live ephemeral snapshot
router.get("/:id/report-snapshot", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: {
        id: true,
        status: true,
        testOrders: {
          select: {
            workflowMode: true,
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({ error: "Visit not found" });
    }

    if (getReportInclusionOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not have a report snapshot.",
      });
    }

    const loaded = await loadFinalizedReportSnapshotForVisit(id);
    if (loaded.ok) {
      return res.json(loaded.snapshot);
    }

    const snapshot = await buildEphemeralSnapshot(id);
    return res.json(snapshot);
  } catch (err: any) {
    console.error("Report snapshot error:", err);
    return res.status(500).json({
      error: "SNAPSHOT_FAILED",
      message: err.message || "Failed to load report snapshot",
    });
  }
});

// GET /api/visits/diagnostic/:id/preview-report - Generate ephemeral preview of the report
// Staff can see the actual branded report layout BEFORE finalizing (nothing is saved).
// Default response is the merged PDF (rendered base + appended external uploads), so
// the staff preview matches byte-for-byte what the patient receives. Pass ?format=html
// for the legacy HTML-only view (which does NOT show appended uploads).
router.get("/:id/preview-report", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const format = req.query.format === "html" ? "html" : "pdf";

    // Verify the visit belongs to this branch
    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: {
        id: true,
        status: true,
        testOrders: {
          select: {
            workflowMode: true,
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({ error: "Visit not found" });
    }

    if (getReportInclusionOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not have a report preview.",
      });
    }

    // Optional per-test scoping passed by the partial-release selector so the
    // preview matches exactly what /release-partial will eventually ship.
    // Accepted as either repeated query params or a comma-separated list.
    const rawTestOrderIds = req.query.testOrderIds;
    const selectedTestOrderIds: string[] | null = Array.isArray(rawTestOrderIds)
      ? rawTestOrderIds.map(String)
      : typeof rawTestOrderIds === "string" && rawTestOrderIds.length > 0
        ? rawTestOrderIds.split(",").map((s) => s.trim()).filter(Boolean)
        : null;

    // Build ephemeral snapshot from live data (no persistence)
    const snapshot = await buildEphemeralSnapshot(id, { selectedTestOrderIds });
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    if (format === "html") {
      const html = renderReportHtml(snapshot, { profile: "screen", baseUrl });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.send(html);
    }

    // Default: merged PDF — same writer as the public download path so staff
    // preview matches what the patient downloads (rendered values + appended uploads).
    const pdfBuffer = await generateMergedReportPdf(snapshot, {
      mode: "digital",
      baseUrl,
      qrDataUrl: "", // QR encodes the public token which doesn't exist for drafts
      cache: false,  // never cache draft previews — they change as staff edits
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.send(pdfBuffer);
  } catch (err: any) {
    console.error("Preview report error:", err);
    return res.status(500).json({
      error: "PREVIEW_FAILED",
      message: err.message || "Failed to generate report preview",
    });
  }
});

// GET /api/visits/diagnostic/:id/finalized-report - Staff-only HTML view of the finalized report
router.get("/:id/finalized-report", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const loaded = await loadFinalizedReportSnapshotForVisit(id);

    if (!loaded.ok) {
      return res.status(loaded.status).json({
        error: loaded.error,
        message: loaded.message,
      });
    }

    const autoPrint = req.query.print === "true";
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const qrDataUrl = autoPrint
      ? await QRCode.toDataURL(
          `${baseUrl}/reports/${await createAccessToken(loaded.reportVersionId)}`,
          {
            width: 100,
            margin: 1,
            color: { dark: "#000000", light: "#ffffff" },
          },
        )
      : "";

    const html = renderReportHtml(loaded.snapshot, {
      // Physical print uses pre-printed ledger paper, so the HTML must omit
      // the built-in report header/footer when the browser print dialog opens.
      profile: autoPrint ? "pdf-physical" : "screen",
      baseUrl,
      qrDataUrl,
    });
    const finalHtml = autoPrint
      ? html.replace(
          "</body>",
          "<script>window.onload=function(){setTimeout(function(){window.print()},600)}</script></body>",
        )
      : html;

    await recordAccessByReportVersionId(
      loaded.reportVersionId,
      autoPrint ? "PRINT" : "VIEW",
      req.ip,
      req.get("user-agent"),
      req.user?.id,
    );

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(finalHtml);
  } catch (err: any) {
    console.error("Finalized report view error:", err);
    return res.status(500).json({
      error: "GENERATION_FAILED",
      message: "Failed to generate finalized report view",
    });
  }
});

// GET /api/visits/diagnostic/:id/finalized-report/pdf - Staff-only finalized report PDF
router.get("/:id/finalized-report/pdf", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
```
