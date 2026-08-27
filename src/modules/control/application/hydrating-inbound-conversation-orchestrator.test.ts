import assert from "node:assert/strict";
import { test } from "node:test";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import type { SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import type { ConsolidatedInboundConversation } from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import type { HydratedContext } from "@/modules/memory/domain/hydrated-context";
import type { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";
import { OutboundMessageRejectedError } from "@/modules/control/application/registered-outbound-message-sender";

function context(state: string = "open"): HydratedContext {
  return {
    tenant: { id: "tenant-1", timezone: "America/New_York", policyVersion: "v1", status: "active", flags: {
      sofiaEnabled: true, qualificationFlowEnabled: true, qualificationSignalEnabled: false,
    }, policies: {
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
  assert.match(String(sent[0]?.content), /Sofía/);
  assert.match(String(sent[0]?.semanticHash), /^[a-f0-9]{64}$/);
});

test("semantic repetition veto is terminal and does not requeue the inbound batch", async () => {
  const logs: string[] = [];
  const flow = {
    sendSofiaResponse: async () => {
      throw new OutboundMessageRejectedError("WAIT", "semantic repetition");
    },
  } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = { load: async () => undefined, save: async () => undefined };
  const hydrator = { hydrate: async () => context() } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(
    hydrator,
    flow,
    { engine: new SofiaConversationEngine(), repository, dealerName: "Test Dealer" },
    undefined,
    false,
    { info: (message) => logs.push(message), error: (message) => logs.push(`error:${message}`) },
  );

  await orchestrator.process(inbound());

  assert.equal(logs.some((message) => message.includes("Sofia outbound suppressed") && message.includes("action=WAIT")), true);
  assert.equal(logs.some((message) => message.startsWith("error:")), false);
});

test("Sofia routes Messenger and Instagram to the supported GHL channel types", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const flow = {
    sendSofiaResponse: async (input: Record<string, unknown>) => { sent.push(input); return { providerMessageId: "ghl-message-1" }; },
  } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = { load: async () => undefined, save: async () => undefined };
  const hydrator = { hydrate: async () => context() } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(hydrator, flow, { engine: new SofiaConversationEngine(), repository, dealerName: "Test Dealer" });

  for (const [channel, expectedChannel] of [["messenger", "FB"], ["instagram", "IG"]] as const) {
    await orchestrator.process({
      ...inbound(),
      messages: [{ ...inbound().messages[0], externalId: `inbound-${channel}`, channel }],
    });
    assert.equal(sent.at(-1)?.channel, expectedChannel);
  }
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

test("tenant Sofia flag disables state persistence and outbound delivery", async () => {
  let saveCount = 0;
  let sendCount = 0;
  const flow = { sendSofiaResponse: async () => { sendCount += 1; return { providerMessageId: "unused" }; } } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = {
    load: async () => undefined,
    save: async () => { saveCount += 1; },
  };
  const hydrator = {
    hydrate: async () => ({ ...context(), tenant: { ...context().tenant, flags: {
      sofiaEnabled: false, qualificationFlowEnabled: true, qualificationSignalEnabled: false,
    } } }),
  } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(hydrator, flow, { engine: new SofiaConversationEngine(), repository, dealerName: "Test Dealer" });

  await orchestrator.process(inbound());

  assert.equal(saveCount, 0);
  assert.equal(sendCount, 0);
});

test("tenant qualification-flow flag blocks Sofia outbound while allowing state persistence", async () => {
  let saveCount = 0;
  let sendCount = 0;
  const flow = { sendSofiaResponse: async () => { sendCount += 1; return { providerMessageId: "unused" }; } } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = {
    load: async () => undefined,
    save: async () => { saveCount += 1; },
  };
  const base = context();
  const hydrator = {
    hydrate: async () => ({ ...base, tenant: { ...base.tenant, flags: {
      sofiaEnabled: true, qualificationFlowEnabled: false, qualificationSignalEnabled: false,
    } } }),
  } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(hydrator, flow, { engine: new SofiaConversationEngine(), repository, dealerName: "Test Dealer" });

  await orchestrator.process(inbound());

  assert.equal(saveCount, 1);
  assert.equal(sendCount, 0);
});

test("unknown dealer identity stays silent instead of using a global dealer name", async () => {
  let saveCount = 0;
  let sendCount = 0;
  const flow = { sendSofiaResponse: async () => { sendCount += 1; return { providerMessageId: "unused" }; } } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = {
    load: async () => undefined,
    save: async () => { saveCount += 1; },
  };
  const hydrator = {
    hydrate: async () => ({ ...context(), tenant: { ...context().tenant, ghlLocationId: "unknown-location" } }),
  } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(hydrator, flow, { engine: new SofiaConversationEngine(), repository });

  await orchestrator.process(inbound());

  assert.equal(saveCount, 0);
  assert.equal(sendCount, 0);
});

test("accepted push is persisted with the selected one-step target", async () => {
  let savedState: Awaited<ReturnType<SofiaStateRepositoryPort["load"]>>;
  const flow = { sendSofiaResponse: async () => ({ providerMessageId: "unused" }) } as unknown as QualificationFlowService;
  const repository: SofiaStateRepositoryPort = {
    load: async () => ({
      turnCount: 1,
      facts: { vehicle_category: "suv", vehicle_use: "solo", down_payment_declared: 1500, down_payment_push_target: 2000, contact_channel: "whatsapp" },
      leadLevel: "B",
      hardRuleFailure: false,
    }),
    save: async (_tenantId, _contactId, state) => { savedState = state; },
  };
  const hydrator = { hydrate: async () => context() } as unknown as ConversationHydrator;
  const orchestrator = new HydratingInboundConversationOrchestrator(hydrator, flow, { engine: new SofiaConversationEngine(), repository, dealerName: "Test Dealer" });

  await orchestrator.process({
    ...inbound(),
    consolidatedText: "Sí, puedo.",
    messages: [{ ...inbound().messages[0], content: "Sí, puedo.", externalId: "push-accepted", channel: "whatsapp" }],
  });

  assert.equal(savedState?.pushAccepted, true);
  assert.equal(savedState?.facts.down_payment_accepted, 2000);
});
