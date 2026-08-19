import { Router } from "express";
import type { WebhookController } from "@/modules/webhooks/presentation/http/webhook.controller";

export function createWebhookRouter(controller: WebhookController): Router {
  const router = Router();
  router.post("/ghl", controller.receiveGhlWebhook);
  return router;
}
