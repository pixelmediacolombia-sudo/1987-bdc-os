import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ProcessInboundWebhookUseCase } from "@/modules/webhooks/application/process-inbound-webhook.use-case";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";
import type { InboundMessage } from "@/modules/webhooks/domain/inbound-webhook-event";
import type { WebhookRepository, WebhookProcessResult } from "@/modules/webhooks/application/ports/webhook-repository.port";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";
import { testMetaEvent } from "@/modules/webhooks/test-meta-event";

test("shared dealer entry matrix ignores advertisement metadata before the real customer message", async () => {
  const policy = await new LocalPolicyPackProvider().load("shared_dealer_v1");
  assert.ok(policy.sofia);
  const result = new SofiaConversationEngine(policy.sofia).processTurn({
    dealerName: "Dealer Demo Inc.",
    latestMessage: "*Headline:* $200 Seguro + $500 de Bono GRATIS\n*Source URL:* https://fb.me/example\n\n¡Hola! Quiero un Toyota Corolla",
    priorFacts: {},
    turnCount: 1,
    isFirstTurn: true,
    contactChannel: "WhatsApp",
    language: "es",
  });

  assert.equal(result.facts.vehicle_model_interest, "Toyota Corolla");
  assert.equal(result.facts.vehicle_category, "sedan");
  assert.equal(result.facts.down_payment_declared, undefined);
  assert.doesNotMatch(result.response ?? "", /\$200|\$500/);
});

test("shared dealer entry matrix logs duplicate Meta deliveries but buffers one customer message", async () => {
  const inboundLog: Array<{ externalId: string; providerMessageId?: string; content: string }> = [];
  const buffered: InboundMessage[] = [];
  const seenProviderMessages = new Set<string>();
  const repository: WebhookRepository = {
    async process(event): Promise<WebhookProcessResult> {
      if (event.inboundMessage) {
        inboundLog.push({
          externalId: event.externalId,
          providerMessageId: event.inboundMessage.providerMessageId,
          content: event.inboundMessage.content,
        });
      }
      const providerMessageId = event.inboundMessage?.providerMessageId;
      const duplicate = Boolean(providerMessageId && seenProviderMessages.has(providerMessageId));
      if (providerMessageId) seenProviderMessages.add(providerMessageId);
      return { duplicate, tenantId: "shared-dealer-local" };
    },
  };
  const burstBuffer: BurstBufferPort = {
    add: async (message) => { buffered.push(message); },
  };
  const useCase = new ProcessInboundWebhookUseCase(repository, burstBuffer);
  const delivery = (externalId: string) => testMetaEvent({
    externalId,
    contactId: "provider-contact-entry-duplicate",
    conversationId: "whatsapp:provider-contact-entry-duplicate",
    eventType: "meta.message.received",
    inboundMessage: {
      externalId,
      providerMessageId: "provider-message-duplicate-001",
      contactId: "provider-contact-entry-duplicate",
      conversationId: "whatsapp:provider-contact-entry-duplicate",
      channel: "whatsapp",
      content: "Hola, busco una RAV4",
      semanticHash: "same-semantic-message",
    },
  });

  const first = await useCase.execute(delivery("delivery-001"));
  const second = await useCase.execute(delivery("delivery-002"));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(inboundLog.length, 2);
  assert.equal(inboundLog[0]?.providerMessageId, inboundLog[1]?.providerMessageId);
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0]?.content, "Hola, busco una RAV4");
  assert.equal(createHash("sha256").update(buffered[0]?.content ?? "").digest("hex").length, 64);
});
