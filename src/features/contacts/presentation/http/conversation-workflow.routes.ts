import express from "express";
import type { Pool } from "pg";
import { ConversationWorkflowController } from "./controllers/conversation-workflow.controller";

export function createConversationWorkflowRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = new ConversationWorkflowController(pool);
  router.patch("/conversations/:conversationId", controller.updateConversationsByConversationId.bind(controller));
  return router;
}
