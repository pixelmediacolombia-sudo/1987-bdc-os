import express from "express";
import type { Pool } from "pg";
import type { IdentityRouteOptions } from "./route-helpers";
import { SessionController } from "./controllers/session.controller";

export function createSessionRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const controller = new SessionController(pool, options);
  router.post("/login", controller.createLogin);

  router.get("/session", controller.getSession);

  router.post("/logout", controller.createLogout);
  return router;
}
