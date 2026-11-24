import express, { type Express } from "express";
import type { PolicyDiagnosticController } from "@/modules/decisions/presentation/http/policy-diagnostic.controller";
import { createPolicyDiagnosticRouter } from "@/modules/decisions/presentation/http/policy-diagnostic.routes";
import type { RedisDiagnosticController } from "@/presentation/http/redis-diagnostic.controller";
import { createRedisDiagnosticRouter } from "@/presentation/http/redis-diagnostic.routes";
import type { OutboundDeliveryReconciliationController } from "@/presentation/http/outbound-delivery-reconciliation.controller";
import { createOutboundDeliveryReconciliationRouter } from "@/presentation/http/outbound-delivery-reconciliation.routes";
import { createInternalDiagnosticGuard, type InternalDiagnosticAuditPort, type InternalDiagnosticCredential } from "@/presentation/http/internal-diagnostic-guard";
import type { MetaWebhookController } from "@/features/meta/presentation/http/meta-webhook.controller";
import { createMetaWebhookRouter } from "@/features/meta/presentation/http/meta-webhook.routes";
import type { MetaOAuthController } from "@/features/meta/presentation/http/meta-oauth.controller";

export type InternalDiagnosticsOptions = {
  credentials: Record<string, InternalDiagnosticCredential>;
  audit: InternalDiagnosticAuditPort;
  production: boolean;
  allowedRemoteIps: string[];
};

export type HttpAppOptions = {
  policyDiagnosticController?: PolicyDiagnosticController;
  redisDiagnosticController?: RedisDiagnosticController;
  outboundDeliveryReconciliationController?: OutboundDeliveryReconciliationController;
  dashboardRouter?: express.Router;
  internalDiagnostics?: InternalDiagnosticsOptions;
  identityRouter?: express.Router;
  localSofiaSimulatorRouter?: express.Router;
  metaWebhook?: { controller: MetaWebhookController; appSecret?: string };
  metaOAuth?: MetaOAuthController;
};

export function createHttpApp(options: HttpAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  if (options.dashboardRouter) app.use("/mi-dia", options.dashboardRouter);
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  if (options.identityRouter) app.use("/auth", express.json({ limit: "16kb" }), options.identityRouter);
  if (options.localSofiaSimulatorRouter) app.use("/auth", express.json({ limit: "16kb" }), options.localSofiaSimulatorRouter);
  if (options.metaOAuth) app.get("/oauth/meta/callback", options.metaOAuth.callback);
  if (options.metaWebhook) app.use("/webhooks/meta", createMetaWebhookRouter(options.metaWebhook.controller, options.metaWebhook.appSecret));
  if (options.internalDiagnostics) {
    const diagnosticsRouter = express.Router();
    diagnosticsRouter.use(createInternalDiagnosticGuard(options.internalDiagnostics));
    if (options.policyDiagnosticController) diagnosticsRouter.use(createPolicyDiagnosticRouter(options.policyDiagnosticController));
    if (options.redisDiagnosticController) diagnosticsRouter.use(createRedisDiagnosticRouter(options.redisDiagnosticController));
    if (options.outboundDeliveryReconciliationController) {
      diagnosticsRouter.use(createOutboundDeliveryReconciliationRouter(options.outboundDeliveryReconciliationController));
    }
    app.use("/internal/admin/diagnostics", diagnosticsRouter);
  }
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}
