import express from "express";
import type { Pool } from "pg";
import type { IdentityRouteOptions } from "./route-helpers";
import { AdminDealerMutationController } from "./controllers/admin-dealer-mutations.controller";

export function createAdminDealerMutationRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const controller = new AdminDealerMutationController(pool, options);
  router.delete("/admin/dealers/:dealerId", controller.deleteAdminDealersByDealerId);

  router.patch("/admin/dealers/:dealerId/name", controller.updateAdminDealersByDealerIdName);

  router.post("/admin/dealers", controller.createAdminDealers);

  router.post("/admin/dealers/:dealerId/invitations", controller.createAdminDealersByDealerIdInvitations);
  return router;
}
