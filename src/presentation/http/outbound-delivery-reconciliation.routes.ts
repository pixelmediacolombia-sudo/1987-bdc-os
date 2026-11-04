import { Router } from "express";
import type { OutboundDeliveryReconciliationController } from "@/presentation/http/outbound-delivery-reconciliation.controller";

export function createOutboundDeliveryReconciliationRouter(
  controller: OutboundDeliveryReconciliationController,
): Router {
  const router = Router();
  router.get("/outbound-deliveries/uncertain", controller.list);
  router.post("/outbound-deliveries/reconcile", controller.reconcile);
  return router;
}
