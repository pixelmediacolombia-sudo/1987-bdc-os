import express from "express";
import type { Pool } from "pg";
import { createConversationWorkflowController } from "./controllers/conversation-workflow.controller";

export function createConversationWorkflowRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = createConversationWorkflowController(pool);
  router.patch("/conversations/:conversationId", controller.updateConversationsByConversationId);
  return router;
}
