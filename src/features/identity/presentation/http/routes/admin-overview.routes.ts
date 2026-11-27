import express from "express";
import type { Pool } from "pg";
import type { IdentityRouteOptions } from "./route-helpers";
import { createAdminOverviewController } from "./controllers/admin-overview.controller";

export function createAdminOverviewRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const controller = createAdminOverviewController(pool, options);
  router.get("/admin/system/health", controller.getAdminSystemHealth);
  router.get("/admin/users", controller.getAdminUsers);
  router.get("/admin/audit", controller.getAdminAudit);
  return router;
}
