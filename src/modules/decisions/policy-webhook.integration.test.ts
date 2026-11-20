import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebhookRepository } from "@/modules/webhooks/application/ports/webhook-repository.port";
import { ProcessInboundWebhookUseCase } from "@/modules/webhooks/application/process-inbound-webhook.use-case";
import type { InboundWebhookEvent } from "@/modules/webhooks/domain/inbound-webhook-event";
import { testMetaEvent } from "@/modules/webhooks/test-meta-event";

test("stop_ai is evaluated by the gateway before downstream suppression", async () => {
  const calls: Array<{ tenantId: string; providerContactId: string; controlTag?: string; source?: string }> = [];
  const repository: WebhookRepository = {
    process: async (_event: InboundWebhookEvent) => ({ duplicate: false, tenantId: "tenant-1" }),
  };
  const evaluator = {
    evaluateForContact: async (input: { tenantId: string; providerContactId: string; controlTag?: string; source?: string }) => {
      calls.push(input);
      return {} as never;
    },
  };

  await new ProcessInboundWebhookUseCase(repository, undefined, undefined, evaluator).execute(testMetaEvent({
    externalId: "stop-ai-1",
    contactId: "provider-contact-1",
    eventType: "meta.control.stop_ai",
    humanInterruption: { trigger: "control_tag", contactId: "provider-contact-1", controlTag: "stop_ai" },
  }));

  assert.deepEqual(calls, [{
    tenantId: "tenant-1",
    providerContactId: "provider-contact-1",
    externalId: "stop-ai-1",
    controlTag: "stop_ai",
    source: "meta-stop-ai",
  }]);
});
