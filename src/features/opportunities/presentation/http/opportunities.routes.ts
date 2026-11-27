import express from "express";
import type { Pool } from "pg";
import { createOpportunitiesController } from "./controllers/opportunities.controller";

export function createOpportunitiesRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = createOpportunitiesController(pool);
  router.get("/dashboard", controller.getDashboard);
  router.get("/opportunities/stages", controller.getOpportunitiesStages);
  router.put("/opportunities/stages", controller.replaceOpportunitiesStages);
  router.get("/opportunities", controller.getOpportunities);
  router.post("/opportunities", controller.createOpportunities);
  router.get("/opportunities/:opportunityId/activity", controller.getOpportunitiesByOpportunityIdActivity);  router.patch("/opportunities/:opportunityId", controller.updateOpportunitiesByOpportunityId);
  return router;
}
