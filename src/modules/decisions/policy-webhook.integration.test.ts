import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebhookRepository } from "@/modules/webhooks/application/ports/webhook-repository.port";
import { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import type { GhlWebhookEvent } from "@/modules/webhooks/domain/ghl-webhook-event";

test("stop_ai is evaluated by the gateway before downstream suppression", async () => {
  const calls: Array<{ tenantId: string; ghlContactId: string; controlTag?: string; source?: string }> = [];
  const repository: WebhookRepository = {
    process: async (_event: GhlWebhookEvent) => ({ duplicate: false, tenantId: "tenant-1" }),
  };
  const evaluator = {
    evaluateForContact: async (input: { tenantId: string; ghlContactId: string; controlTag?: string; source?: string }) => {
      calls.push(input);
      return {} as never;
    },
  };

  await new ProcessGHLWebhookUseCase(repository, undefined, undefined, evaluator).execute({
    payload: {
      eventId: "stop-ai-1",
      eventType: "ContactTagUpdate",
      locationId: "location-1",
      contactId: "ghl-contact-1",
      tags: ["stop_ai"],
    },
    rawBody: Buffer.from("stop-ai-1"),
    signature: "test-signature",
  });

  assert.deepEqual(calls, [{
    tenantId: "tenant-1",
    ghlContactId: "ghl-contact-1",
    controlTag: "stop_ai",
    source: "ghl-stop-ai",
  }]);
});
