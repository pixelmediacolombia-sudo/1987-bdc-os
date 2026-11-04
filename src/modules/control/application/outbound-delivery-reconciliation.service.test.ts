import assert from "node:assert/strict";
import { test } from "node:test";
import { OutboundDeliveryReconciliationService } from "@/modules/control/application/outbound-delivery-reconciliation.service";

test("reconciliation confirms provider acceptance after restart without sending again", async () => {
  const calls: string[] = [];
  const resolved: string[] = [];
  const registry = {
    listDeliveryUncertainties: async () => [{
      tenantId: "tenant-a",
      attemptId: "attempt-a",
      contactId: "contact-a",
      providerMessageId: "ghl-message-a",
      content: "Hola",
      uncertaintyReason: "local association failed",
      detectedAt: new Date(),
      reconciliationAttempts: 0,
    }],
    recordDeliveryReconciliationAttempt: async (input: { result: string }) => { calls.push(input.result); },
    resolveDeliveryUncertainty: async (input: { resolution: string }) => { resolved.push(input.resolution); },
  };
  const service = new OutboundDeliveryReconciliationService(registry as never, {
    lookup: async () => ({ result: "found", providerStatus: "delivered" }),
  });

  const summary = await service.runOnce("tenant-a", "ops@example.com");
  assert.deepEqual(summary, { inspected: 1, confirmed: 1, notFound: 0, stillUnknown: 0 });
  assert.deepEqual(calls, ["found"]);
  assert.deepEqual(resolved, ["confirmed"]);
});

test("provider timeout keeps uncertainty open and records the reason", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const registry = {
    listDeliveryUncertainties: async () => [{
      tenantId: "tenant-a", attemptId: "attempt-a", contactId: "contact-a",
      providerMessageId: "ghl-message-a", content: "Hola", uncertaintyReason: "timeout",
      detectedAt: new Date(), reconciliationAttempts: 0,
    }],
    recordDeliveryReconciliationAttempt: async (input: Record<string, unknown>) => { calls.push(input); },
    resolveDeliveryUncertainty: async () => { throw new Error("must remain open"); },
  };
  const service = new OutboundDeliveryReconciliationService(registry as never, {
    lookup: async () => ({ result: "unknown", error: "provider timeout" }),
  });

  const summary = await service.runOnce("tenant-a", "ops@example.com");
  assert.equal(summary.stillUnknown, 1);
  assert.equal(calls[0]?.error, "provider timeout");
});
