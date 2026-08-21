import { Router } from "express";
import type { PolicyDiagnosticController } from "@/modules/decisions/presentation/http/policy-diagnostic.controller";

export function createPolicyDiagnosticRouter(controller: PolicyDiagnosticController): Router {
  const router = Router();
  router.get("/policy-evaluation", controller.evaluate);
  return router;
}
