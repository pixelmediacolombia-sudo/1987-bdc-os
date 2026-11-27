import express from "express";
import type { Pool } from "pg";
import { ConversationListController } from "./controllers/conversation-list.controller";

export function createConversationListRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = new ConversationListController(pool);
  router.get("/conversations", controller.getConversations);

  router.get("/conversations/assignees", controller.getConversationsAssignees);
  return router;
}
