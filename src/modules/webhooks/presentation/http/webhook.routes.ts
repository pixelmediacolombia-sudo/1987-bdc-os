import { Router } from "express";
import type { WebhookController } from "@/modules/webhooks/presentation/http/webhook.controller";
import { validateGhlSignature } from "@/modules/webhooks/presentation/http/validate-ghl-signature.middleware";

export function createWebhookRouter(controller: WebhookController, ghlClientSecret: string): Router {
  const router = Router();
  router.post("/ghl", validateGhlSignature(ghlClientSecret), controller.receiveGhlWebhook);
  return router;
}
