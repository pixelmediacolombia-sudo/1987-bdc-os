import express from "express";
import type { Pool } from "pg";
import type { IdentityRouteOptions } from "./route-helpers";
import { AdminDealerController } from "./controllers/admin-dealer.controller";

export function createAdminDealerRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const controller = new AdminDealerController(pool, options);
  router.get("/admin/dealers", controller.getAdminDealers);

  router.get("/admin/dealers/:dealerId/meta/connect", controller.getAdminDealersByDealerIdMetaConnect);

  router.get("/admin/dealers/:dealerId/configuration", controller.getAdminDealersByDealerIdConfiguration);

  return router;
}
