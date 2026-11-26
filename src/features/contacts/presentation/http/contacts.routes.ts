import express from "express";
import type { Pool } from "pg";
import type { ConversationReplySender } from "@/features/contacts/application/conversation-reply-sender.port";
import { createContactDirectoryRouter } from "./contact-directory.routes";
import { createContactDetailRouter } from "./contact-detail.routes";
import { createConversationRouter } from "./conversation.routes";

export function createContactsRouter(pool: Pool, replySender?: ConversationReplySender): express.Router {
  const router = express.Router();
  router.use(createContactDirectoryRouter(pool));
  router.use(createContactDetailRouter(pool));
  router.use(createConversationRouter(pool, replySender));
  return router;
}
