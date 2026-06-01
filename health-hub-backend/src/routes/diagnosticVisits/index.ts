import { Router } from "express";
import visitsRouter from "./visits";
import billingRouter from "./billing";
import testsRouter from "./tests";
import reportsRouter from "./reports";
import { authMiddleware } from "../../middleware/auth";
import { branchContextMiddleware } from "../../middleware/branch";

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

router.use("/", visitsRouter);
router.use("/", billingRouter);
router.use("/", testsRouter);
router.use("/", reportsRouter);

export default router;
