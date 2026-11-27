import express from "express";
import type { Pool } from "pg";
import { OpportunitiesController } from "./controllers/opportunities.controller";

export function createOpportunitiesRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = new OpportunitiesController(pool);
  router.get("/dashboard", controller.getDashboard.bind(controller));
  router.get("/opportunities/stages", controller.getOpportunitiesStages.bind(controller));
  router.put("/opportunities/stages", controller.replaceOpportunitiesStages.bind(controller));
  router.get("/opportunities", controller.getOpportunities.bind(controller));
  router.post("/opportunities", controller.createOpportunities.bind(controller));
  router.get("/opportunities/:opportunityId/activity", controller.getOpportunitiesByOpportunityIdActivity.bind(controller));  router.patch("/opportunities/:opportunityId", controller.updateOpportunitiesByOpportunityId.bind(controller));
  return router;
}
