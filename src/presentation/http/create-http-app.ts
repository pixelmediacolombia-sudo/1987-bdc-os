import express, { type Express } from "express";
import type { GhlOAuthController } from "@/features/ghl-oauth/presentation/http/ghl-oauth.controller";
import { createGhlOAuthRouter } from "@/features/ghl-oauth/presentation/http/ghl-oauth.routes";
import type { WebhookController } from "@/modules/webhooks/presentation/http/webhook.controller";
import {
  captureRawBody,
  parseCapturedJsonBody,
  type GhlSignatureKeys,
  validateGhlSignature,
} from "@/modules/webhooks/presentation/http/validate-ghl-signature.middleware";
import { createWebhookRouter } from "@/modules/webhooks/presentation/http/webhook.routes";
import type { PolicyDiagnosticController } from "@/modules/decisions/presentation/http/policy-diagnostic.controller";
import { createPolicyDiagnosticRouter } from "@/modules/decisions/presentation/http/policy-diagnostic.routes";
import type { RedisDiagnosticController } from "@/presentation/http/redis-diagnostic.controller";
import { createRedisDiagnosticRouter } from "@/presentation/http/redis-diagnostic.routes";

export function createHttpApp(
  controller: GhlOAuthController,
  webhookController: WebhookController,
  signatureKeys?: GhlSignatureKeys,
  policyDiagnosticController?: PolicyDiagnosticController,
  redisDiagnosticController?: RedisDiagnosticController,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.use("/oauth", createGhlOAuthRouter(controller));
  app.use(
    "/webhooks/ghl",
    express.raw({ type: "*/*", limit: "100kb", verify: captureRawBody }),
    validateGhlSignature(signatureKeys),
    parseCapturedJsonBody,
  );
  app.use("/webhooks", createWebhookRouter(webhookController));
  if (policyDiagnosticController) {
    app.use("/tests", createPolicyDiagnosticRouter(policyDiagnosticController));
  }
  if (redisDiagnosticController) {
    app.use("/tests", createRedisDiagnosticRouter(redisDiagnosticController));
  }
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}
