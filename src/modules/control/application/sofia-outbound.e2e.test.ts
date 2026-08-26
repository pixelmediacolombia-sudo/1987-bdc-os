import assert from "node:assert/strict";
import { test } from "node:test";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import type { SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import type { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { HydratedContext } from "@/modules/memory/domain/hydrated-context";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";

test("application E2E: inbound dealer turn is persisted and delivered through the outbound boundary", async () => {
  const deliveries: Array<{ tenantId: string; contactId: string; channel?: string; content: string }> = [];
  const saved: string[] = [];
  const flow = {
    sendSofiaResponse: async (input: { tenantId: string; contactId: string; channel?: string; content: string }) => {
      deliveries.push(input);
      return { providerMessageId: "controlled-ghl-provider-message" };
    },
  } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = {
    load: async () => undefined,
    save: async (_tenantId, _contactId, state) => { saved.push(state.lastResponse ?? ""); },
  };
  const hydrated: HydratedContext = {
    tenant: { id: "dealer-tenant-1", timezone: "America/New_York", policyVersion: "v1", status: "active", flags: {
      sofiaEnabled: true, qualificationFlowEnabled: true, qualificationSignalEnabled: false,
    }, policies: {
      version: "v1", downPayment: { min: null, max: null, currency: "USD" },
      quietHours: { enabled: false, start: null, end: null }, humanHandoff: { enabled: true, triggers: [] },
    } },
    contact: { id: "ghl-contact-1", ghlContactId: "ghl-contact-1", preferredLanguage: "es", consentState: "granted" },
    conversation: { id: "conversation-1", channel: "WhatsApp", state: "open" },
    transcript: [], activeFacts: {}, objectivesLedger: [],
  };
  const hydrator = { hydrate: async () => hydrated } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(
    hydrator,
    flow,
    { engine: new SofiaConversationEngine(), repository, dealerName: "Dealer E2E" },
  );

  await orchestrator.process({
    tenantId: "dealer-tenant-1",
    contactId: "ghl-contact-1",
    consolidatedText: "Hola, busco una SUV.",
    messages: [{
      externalId: "real-flow-boundary-1",
      contactId: "ghl-contact-1",
      channel: "WhatsApp",
      content: "Hola, busco una SUV.",
      semanticHash: "inbound-hash",
      receivedAt: new Date().toISOString(),
    }],
  });

  assert.equal(saved.length, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.tenantId, "dealer-tenant-1");
  assert.equal(deliveries[0]?.contactId, "ghl-contact-1");
  assert.equal(deliveries[0]?.channel, "WhatsApp");
  assert.equal(deliveries[0]?.content, saved[0]);
});
