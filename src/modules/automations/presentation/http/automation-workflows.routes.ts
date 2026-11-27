import express from "express";
import type { Pool } from "pg";
import { AutomationWorkflowsController } from "./controllers/automation-workflows.controller";

export function createAutomationWorkflowsRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = new AutomationWorkflowsController(pool);
  router.get("/automation/workflows", controller.getAutomationWorkflows);

  router.post("/automation/workflows", controller.createAutomationWorkflows);

  router.get("/automation/workflows/:workflowId", controller.getAutomationWorkflowsByWorkflowId);

  router.put("/automation/workflows/:workflowId/draft", controller.replaceAutomationWorkflowsByWorkflowIdDraft);

  router.post("/automation/workflows/:workflowId/publish", controller.publishAutomationWorkflowsByWorkflowId);

  router.get("/automation/workflows/:workflowId/runs", controller.getAutomationWorkflowsByWorkflowIdRuns);

  router.post("/automation/runs/:runId/cancel", controller.createAutomationRunsByRunIdCancel);

  router.post("/automation/runs/:runId/retry", controller.createAutomationRunsByRunIdRetry);

  router.post("/automation/runs/:runId/replay", controller.createAutomationRunsByRunIdReplay);
  return router;
}
