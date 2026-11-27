import express from "express";
import type { Pool } from "pg";
import type { ConversationReplySender } from "@/features/contacts/application/conversation-reply-sender.port";
import { createConversationMessageController } from "./controllers/conversation-messages.controller";

export function createConversationMessageRouter(pool: Pool, replySender?: ConversationReplySender): express.Router {
  const router = express.Router();
  const controller = createConversationMessageController(pool, replySender);
  router.post("/conversations/:conversationId/messages", controller.createConversationsByConversationIdMessages);
  return router;
}
