import type {
  OutboundDeliveryReconciliationProviderPort,
  ProviderDeliveryLookup,
} from "@/modules/control/application/ports/outbound-delivery-reconciliation.port";
import type { OutboundMessageRegistryPort } from "@/modules/control/application/ports/outbound-message-registry.port";

/** Reconciles provider-accepted messages after a process or database restart. */
export class OutboundDeliveryReconciliationService {
  constructor(
    private readonly registry: OutboundMessageRegistryPort,
    private readonly provider: OutboundDeliveryReconciliationProviderPort,
  ) {}

  async runOnce(tenantId: string, reviewer: string): Promise<{
    inspected: number;
    confirmed: number;
    notFound: number;
    stillUnknown: number;
  }> {
    if (!this.registry.listDeliveryUncertainties ||
        !this.registry.recordDeliveryReconciliationAttempt ||
        !this.registry.resolveDeliveryUncertainty) {
      throw new Error("Outbound delivery reconciliation is not configured");
    }
    const pending = await this.registry.listDeliveryUncertainties(tenantId);
    const summary = { inspected: 0, confirmed: 0, notFound: 0, stillUnknown: 0 };
    for (const delivery of pending) {
      summary.inspected += 1;
      let lookup: ProviderDeliveryLookup;
      try {
        lookup = await this.provider.lookup({
          tenantId,
          contactId: delivery.contactId,
          providerMessageId: delivery.providerMessageId,
        });
      } catch (error) {
        lookup = {
          result: "unknown",
          error: error instanceof Error ? error.message : "provider lookup failed",
        };
      }
      await this.registry.recordDeliveryReconciliationAttempt({
        tenantId,
        attemptId: delivery.attemptId,
        result: lookup.result,
        ...(lookup.providerStatus ? { providerStatus: lookup.providerStatus } : {}),
        ...(lookup.error ? { error: lookup.error } : {}),
      });
      if (lookup.result === "found") {
        await this.registry.resolveDeliveryUncertainty({
          tenantId,
          attemptId: delivery.attemptId,
          resolution: "confirmed",
          reviewer,
          ...(lookup.providerStatus ? { providerStatus: lookup.providerStatus } : {}),
        });
        summary.confirmed += 1;
      } else if (lookup.result === "not_found") {
        await this.registry.resolveDeliveryUncertainty({
          tenantId,
          attemptId: delivery.attemptId,
          resolution: "not_found",
          reviewer,
          ...(lookup.providerStatus ? { providerStatus: lookup.providerStatus } : {}),
        });
        summary.notFound += 1;
      } else {
        summary.stillUnknown += 1;
      }
    }
    return summary;
  }
}
