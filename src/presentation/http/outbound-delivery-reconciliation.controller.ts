import type { Request, Response } from "express";
import type { OutboundDeliveryReconciliationService } from "@/modules/control/application/outbound-delivery-reconciliation.service";
import type { OutboundMessageRegistryPort } from "@/modules/control/application/ports/outbound-message-registry.port";

export class OutboundDeliveryReconciliationController {
  constructor(
    private readonly registry: OutboundMessageRegistryPort,
    private readonly reconciliation: OutboundDeliveryReconciliationService,
    private readonly token?: string,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    if (!this.authorized(req)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const tenantId = this.tenantId(req);
    if (!tenantId || !this.registry.listDeliveryUncertainties) {
      res.status(400).json({ error: "tenant_id is required" });
      return;
    }
    res.status(200).json({ deliveries: await this.registry.listDeliveryUncertainties(tenantId) });
  };

  reconcile = async (req: Request, res: Response): Promise<void> => {
    if (!this.authorized(req)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const tenantId = this.tenantId(req);
    const reviewer = String(req.query.reviewer ?? req.get("x-reviewer") ?? "").trim();
    if (!tenantId || !reviewer) {
      res.status(400).json({ error: "tenant_id and reviewer are required" });
      return;
    }
    res.status(200).json(await this.reconciliation.runOnce(tenantId, reviewer));
  };

  private authorized(req: Request): boolean {
    return Boolean(this.token && req.get("x-policy-diagnostic-token") === this.token);
  }

  private tenantId(req: Request): string | undefined {
    const value = String(req.query.tenant_id ?? "").trim();
    return value || undefined;
  }
}
