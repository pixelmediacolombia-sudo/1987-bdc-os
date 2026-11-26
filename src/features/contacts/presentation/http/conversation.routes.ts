import express from "express";
import type { Pool } from "pg";
import type { ConversationReplySender } from "@/features/contacts/application/conversation-reply-sender.port";
import { createConversationListRouter } from "./conversation-list.routes";
import { createConversationMessageRouter } from "./conversation-messages.routes";
import { createConversationWorkflowRouter } from "./conversation-workflow.routes";

export function createConversationRouter(pool: Pool, replySender?: ConversationReplySender): express.Router {
  const router = express.Router();
  router.use(createConversationListRouter(pool));
  router.use(createConversationMessageRouter(pool, replySender));
  router.use(createConversationWorkflowRouter(pool));
  return router;
}
