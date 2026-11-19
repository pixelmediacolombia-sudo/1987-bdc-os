import type { Request, Response } from "express";
import type { OutboundDeliveryReconciliationService } from "@/modules/control/application/outbound-delivery-reconciliation.service";
import type { OutboundMessageRegistryPort } from "@/modules/control/application/ports/outbound-message-registry.port";
import { internalDiagnosticIdentity } from "@/presentation/http/internal-diagnostic-guard";

export class OutboundDeliveryReconciliationController {
  constructor(
    private readonly registry: OutboundMessageRegistryPort,
    private readonly reconciliation: OutboundDeliveryReconciliationService,
  ) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    const identity = internalDiagnosticIdentity(res);
    if (!identity) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!this.registry.listDeliveryUncertainties) {
      res.status(503).json({ error: "Outbound delivery diagnostics are unavailable" });
      return;
    }
    res.status(200).json({ deliveries: await this.registry.listDeliveryUncertainties(identity.tenantId) });
  };

  reconcile = async (_req: Request, res: Response): Promise<void> => {
    const identity = internalDiagnosticIdentity(res);
    if (!identity) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(await this.reconciliation.runOnce(identity.tenantId, identity.actor));
  }
}
