import express from "express";
import type { Pool } from "pg";
import type { IdentityRouteOptions } from "./route-helpers";
import { AdminOverviewController } from "./controllers/admin-overview.controller";

export function createAdminOverviewRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const controller = new AdminOverviewController(pool, options);
  router.get("/admin/system/health", controller.getAdminSystemHealth.bind(controller));
  router.get("/admin/users", controller.getAdminUsers.bind(controller));
  router.get("/admin/audit", controller.getAdminAudit.bind(controller));
  return router;
}
