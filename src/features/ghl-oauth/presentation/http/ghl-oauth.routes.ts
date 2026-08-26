import { Router } from "express";
import type { GhlOAuthController } from "@/features/ghl-oauth/presentation/http/ghl-oauth.controller";

export function createGhlOAuthRouter(controller: GhlOAuthController): Router {
  const router = Router();
  router.get("/initiate", controller.initiateHandler);
  router.get("/callback", controller.completeHandler);
  // Alias used by the clean/custom callback domain. Keep the legacy callback
  // during migration so existing OAuth installations do not break.
  router.get("/return", controller.completeHandler);
  return router;
}
