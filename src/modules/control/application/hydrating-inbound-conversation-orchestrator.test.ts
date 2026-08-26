import assert from "node:assert/strict";
import { test } from "node:test";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import type { SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import type { ConsolidatedInboundConversation } from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import type { HydratedContext } from "@/modules/memory/domain/hydrated-context";
import type { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";

function context(state: string = "open"): HydratedContext {
  return {
    tenant: { id: "tenant-1", timezone: "America/New_York", policyVersion: "v1", status: "active", policies: {
      version: "v1", downPayment: { min: null, max: null, currency: "USD" },
      quietHours: { enabled: false, start: null, end: null }, humanHandoff: { enabled: true, triggers: [] },
    } },
    contact: { id: "contact-1", ghlContactId: "contact-1", preferredLanguage: "es", consentState: "granted" },
    conversation: { id: "conversation-1", channel: "WhatsApp", state },
    transcript: [],
    activeFacts: {},
    objectivesLedger: [],
  };
}

function inbound(): ConsolidatedInboundConversation {
  return {
    tenantId: "tenant-1",
    contactId: "contact-1",
    consolidatedText: "Hola, busco una SUV.",
    messages: [{
      externalId: "inbound-1",
      contactId: "contact-1",
      channel: "whatsapp",
      content: "Hola, busco una SUV.",
      semanticHash: "inbound-hash",
      receivedAt: new Date().toISOString(),
    }],
  };
}

test("Sofia response is sent to the connected dealer using the inbound channel", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const flow = {
    sendSofiaResponse: async (input: Record<string, unknown>) => { sent.push(input); return { providerMessageId: "ghl-message-1" }; },
  } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = {
    load: async () => undefined,
    save: async () => undefined,
  };
  const hydrator = { hydrate: async () => context() } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(hydrator, flow, { engine: new SofiaConversationEngine(), repository, dealerName: "Test Dealer" });

  await orchestrator.process(inbound());

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.tenantId, "tenant-1");
  assert.equal(sent[0]?.contactId, "contact-1");
  assert.equal(sent[0]?.channel, "WhatsApp");
  assert.equal(sent[0]?.externalId, "inbound-1");
  assert.match(String(sent[0]?.content), /Sofía de Test Dealer/);
  assert.match(String(sent[0]?.semanticHash), /^[a-f0-9]{64}$/);
});

test("Sofia does not send when human takeover has paused the conversation", async () => {
  let sendCount = 0;
  const flow = { sendSofiaResponse: async () => { sendCount += 1; return { providerMessageId: "unused" }; } } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = { load: async () => undefined, save: async () => undefined };
  const hydrator = { hydrate: async () => context("paused") } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(hydrator, flow, { engine: new SofiaConversationEngine(), repository, dealerName: "Test Dealer" });

  await orchestrator.process(inbound());

  assert.equal(sendCount, 0);
});
