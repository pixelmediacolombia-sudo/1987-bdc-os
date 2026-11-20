import express, { Router, type RequestHandler } from "express";
import type { MetaWebhookController } from "@/features/meta/presentation/http/meta-webhook.controller";
import { isValidMetaWebhookSignature } from "@/features/meta/domain/meta-webhook.signature";
import { captureRawBody, parseCapturedJsonBody, type RawBodyRequest } from "@/modules/webhooks/presentation/http/raw-body.middleware";

function validateSignature(appSecret?: string): RequestHandler {
  return (request, response, next) => {
    const rawBody = (request as RawBodyRequest).rawBody;
    const signature = request.get("x-hub-signature-256") ?? "";
    if (!appSecret || !rawBody || !isValidMetaWebhookSignature(rawBody, signature, appSecret)) {
      response.status(appSecret ? 401 : 503).json({ error: appSecret ? "Invalid Meta webhook signature" : "Meta webhook secret is not configured" });
      return;
    }
    next();
  };
}

export function createMetaWebhookRouter(controller: MetaWebhookController, appSecret?: string): Router {
  const router = Router();
  router.get("/", controller.verify);
  router.post(
    "/",
    express.raw({ type: "*/*", limit: "100kb", verify: captureRawBody }),
    validateSignature(appSecret),
    parseCapturedJsonBody,
    controller.receive,
  );
  return router;
}
