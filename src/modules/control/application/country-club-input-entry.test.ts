import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";
import type { InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";
import type { WebhookRepository, WebhookProcessResult } from "@/modules/webhooks/application/ports/webhook-repository.port";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";

test("Country Club entry matrix ignores advertisement metadata before the real customer message", async () => {
  const policy = await new LocalPolicyPackProvider().load("country_club_cars_v8");
  assert.ok(policy.sofia);
  const result = new SofiaConversationEngine(policy.sofia).processTurn({
    dealerName: "Country Club Cars Inc.",
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

test("Country Club entry matrix logs two inbound deliveries but buffers one duplicate customer message", async () => {
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
      return { duplicate, tenantId: "country-club-local" };
    },
  };
  const burstBuffer: BurstBufferPort = {
    add: async (message) => { buffered.push(message); },
  };
  const useCase = new ProcessGHLWebhookUseCase(repository, burstBuffer);
  const basePayload = {
    eventType: "InboundMessage",
    locationId: "country-club-location-local",
    contactId: "ghl-contact-country-club-entry-duplicate",
    conversationId: "ghl-conversation-country-club-entry-duplicate",
    direction: "inbound",
    messageType: "WhatsApp",
    messageId: "provider-message-duplicate-001",
    message: { body: "Hola, busco una RAV4", },
  };

  const first = await useCase.execute({ payload: { ...basePayload, eventId: "delivery-001" }, rawBody: Buffer.from("delivery-001"), signature: "local-signature" });
  const second = await useCase.execute({ payload: { ...basePayload, eventId: "delivery-002" }, rawBody: Buffer.from("delivery-002"), signature: "local-signature" });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(inboundLog.length, 2);
  assert.equal(inboundLog[0]?.providerMessageId, inboundLog[1]?.providerMessageId);
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0]?.content, "Hola, busco una RAV4");
  assert.equal(createHash("sha256").update(buffered[0]?.content ?? "").digest("hex").length, 64);
});
