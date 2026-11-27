import express from "express";
import type { Pool } from "pg";
import type { IdentityRouteOptions } from "./route-helpers";
import { createInvitationController } from "./controllers/invitation.controller";

export function createInvitationRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const controller = createInvitationController(pool, options);
  router.get("/invitations/accept", controller.getInvitationsAccept);

  router.post("/invitations/accept", controller.createInvitationsAccept);
  return router;
}
