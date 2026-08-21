import { Router } from "express";
import type { RedisDiagnosticController } from "@/presentation/http/redis-diagnostic.controller";

export function createRedisDiagnosticRouter(controller: RedisDiagnosticController): Router {
  const router = Router();
  router.get("/redis-health", controller.health);
  return router;
}
