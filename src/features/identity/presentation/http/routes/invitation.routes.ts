import express from "express";
import type { Pool } from "pg";
import type { IdentityRouteOptions } from "./route-helpers";
import { InvitationController } from "./controllers/invitation.controller";

export function createInvitationRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const controller = new InvitationController(pool, options);
  router.get("/invitations/accept", controller.getInvitationsAccept.bind(controller));

  router.post("/invitations/accept", controller.createInvitationsAccept.bind(controller));
  return router;
}
