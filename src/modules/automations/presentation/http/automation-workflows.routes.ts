import express from "express";
import type { Pool } from "pg";
import { AutomationWorkflowsController } from "./controllers/automation-workflows.controller";

export function createAutomationWorkflowsRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = new AutomationWorkflowsController(pool);
  router.get("/automation/workflows", controller.getAutomationWorkflows.bind(controller));

  router.post("/automation/workflows", controller.createAutomationWorkflows.bind(controller));

  router.get("/automation/workflows/:workflowId", controller.getAutomationWorkflowsByWorkflowId.bind(controller));

  router.put("/automation/workflows/:workflowId/draft", controller.replaceAutomationWorkflowsByWorkflowIdDraft.bind(controller));

  router.post("/automation/workflows/:workflowId/publish", controller.publishAutomationWorkflowsByWorkflowId.bind(controller));

  router.get("/automation/workflows/:workflowId/runs", controller.getAutomationWorkflowsByWorkflowIdRuns.bind(controller));

  router.post("/automation/runs/:runId/cancel", controller.createAutomationRunsByRunIdCancel.bind(controller));

  router.post("/automation/runs/:runId/retry", controller.createAutomationRunsByRunIdRetry.bind(controller));

  router.post("/automation/runs/:runId/replay", controller.createAutomationRunsByRunIdReplay.bind(controller));
  return router;
}
