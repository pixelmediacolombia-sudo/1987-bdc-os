import express from "express";
import type { Pool } from "pg";
import type { IdentityRouteOptions } from "./route-helpers";
import { AdminDealerMutationController } from "./controllers/admin-dealer-mutations.controller";

export function createAdminDealerMutationRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const controller = new AdminDealerMutationController(pool, options);
  router.delete("/admin/dealers/:dealerId", controller.deleteAdminDealersByDealerId.bind(controller));

  router.patch("/admin/dealers/:dealerId/name", controller.updateAdminDealersByDealerIdName.bind(controller));

  router.post("/admin/dealers", controller.createAdminDealers.bind(controller));

  router.post("/admin/dealers/:dealerId/invitations", controller.createAdminDealersByDealerIdInvitations.bind(controller));
  return router;
}
