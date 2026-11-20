import assert from "node:assert/strict";
import { test } from "node:test";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import type { SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import type { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { HydratedContext } from "@/modules/memory/domain/hydrated-context";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";
import { FixtureMediaUnderstandingAdapter } from "@/modules/media/application/fixture-media-understanding.adapter";
import { AUDIO_TEXT, IMAGE_TEXT, fixtureAdapter } from "@/modules/media/media-test-fixtures";
import { ProcessInboundWebhookUseCase } from "@/modules/webhooks/application/process-inbound-webhook.use-case";
import type { WebhookRepository } from "@/modules/webhooks/application/ports/webhook-repository.port";
import type { WebhookProcessResult } from "@/modules/webhooks/application/ports/webhook-repository.port";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";

const TENANT_ID = "dealer-media-e2e";
const CONTACT_ID = "contact-media-e2e";

const hydrated: HydratedContext = {
  tenant: {
    id: TENANT_ID,
    timezone: "America/Bogota",
    policyVersion: "v1",
    status: "active",
    flags: { sofiaEnabled: true, qualificationFlowEnabled: true, qualificationSignalEnabled: false },
    policies: {
      version: "v1",
      downPayment: { min: null, max: null, currency: "USD" },
      quietHours: { enabled: false, start: null, end: null },
      humanHandoff: { enabled: true, triggers: [] },
    },
  },
  contact: { id: CONTACT_ID, providerContactId: CONTACT_ID, preferredLanguage: "es", consentState: "granted" },
  conversation: { id: "conversation-media-e2e", channel: "whatsapp", state: "open" },
  transcript: [],
  activeFacts: {},
  objectivesLedger: [],
};

class InMemoryWebhookRepository implements WebhookRepository {
  readonly persisted: string[] = [];

  async process(event: Parameters<WebhookRepository["process"]>[0]): Promise<WebhookProcessResult> {
    this.persisted.push(event.inboundMessage?.content ?? "");
    return { duplicate: false, tenantId: TENANT_ID };
  }
}

test("E2E multimodal: audio entra al flujo y la imagen no expone OCR", async () => {
  const responses: string[] = [];
  let savedState: Awaited<ReturnType<SofiaStateRepositoryPort["load"]>>;
  const flow = {
    sendSofiaResponse: async (input: { content: string }) => {
      responses.push(input.content);
      return { providerMessageId: `media-e2e-${responses.length}` };
    },
  } as unknown as QualificationFlowService;
  const stateRepository: SofiaStateRepositoryPort = {
    load: async () => savedState,
    save: async (_tenantId, _contactId, state) => { savedState = state; },
  };
  const orchestrator = new HydratingInboundConversationOrchestrator(
    { hydrate: async () => hydrated } as unknown as ConversationHydrator,
    flow,
    { engine: new SofiaConversationEngine(), repository: stateRepository, dealerName: "Dealer Demo Inc." },
  );
  const repository = new InMemoryWebhookRepository();
  const burstBuffer: BurstBufferPort = {
    add: async (message, tenantId) => {
      await orchestrator.process({
        tenantId,
        contactId: message.contactId,
        messages: [{ ...message, receivedAt: new Date().toISOString() }],
        consolidatedText: message.content,
        mediaContext: message.mediaSignals,
      });
    },
  };
  const useCase = new ProcessInboundWebhookUseCase(repository, burstBuffer, undefined, undefined, undefined, fixtureAdapter());

  await useCase.execute(mediaEvent("media-e2e-audio", "audio", "family-suv.wav"));
  for (let attempt = 0; attempt < 20 && responses.length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  await useCase.execute(mediaEvent("media-e2e-image", "image", "qualification-signals.svg"));
  for (let attempt = 0; attempt < 20 && responses.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(repository.persisted.length, 2);
  assert.match(repository.persisted[0] ?? "", new RegExp(AUDIO_TEXT.slice(0, 35).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(repository.persisted[1], "Adjunto de image");
  assert.doesNotMatch(repository.persisted[1] ?? "", /Busco una SUV|Enganche disponible/);
  assert.equal(responses.length, 2);
  assert.ok(responses.every((response) => response.trim().length > 0));
  assert.equal(savedState?.turnCount, 2);
  assert.equal(savedState?.facts.vehicle_category, "suv");
  assert.equal(savedState?.facts.vehicle_use, "familia");
  assert.equal(savedState?.facts.down_payment_declared, 2500);
  assert.equal(responses[0], "Hola! Te saludamos desde Dealer Demo Inc.. Soy Sofía.\nPerfecto, para familia la SUV es buena opción. ¿Tienes algún carro que puedas dar de parte de pago? Eso te ayudaría bastante con el enganche.");
  assert.equal(responses[1], "Gracias por compartirla. Seguimos con la información de tu compra.\n¿Tienes algún carro que puedas dar de parte de pago? Eso te ayudaría bastante con el enganche.");
  console.log(`MEDIA_E2E_RESPONSES audio=${JSON.stringify(responses[0])} image=${JSON.stringify(responses[1])}`);
  assert.equal(typeof IMAGE_TEXT, "string");
});

function mediaEvent(externalId: string, kind: "audio" | "image", filename: string) {
  return {
    provider: "meta" as const,
    externalId,
    eventType: "meta.message.received",
    accountId: "meta-account-media-e2e",
    signature: "local-test",
    rawBody: Buffer.from("{}"),
    payload: {},
    contactId: CONTACT_ID,
    inboundMessage: {
      externalId,
      contactId: CONTACT_ID,
      conversationId: "whatsapp:meta-account-media-e2e:contact-media-e2e",
      channel: "whatsapp",
      content: kind === "audio" ? "Adjunto de audio" : "Adjunto de image",
      semanticHash: `hash-${externalId}`,
      attachments: [{ kind, filename, localPath: `fixtures/media/${filename}` }],
    },
  };
}

test("el adaptador de fixtures no se confunde con el proveedor local", async () => {
  const adapter = new FixtureMediaUnderstandingAdapter({
    "family-suv.wav": { kind: "audio", text: AUDIO_TEXT, source: "fixture" },
  });
  const result = await adapter.understand({ kind: "audio", filename: "family-suv.wav", localPath: "fixtures/media/family-suv.wav" });
  assert.equal(result.source, "fixture");
  assert.equal(result.text, AUDIO_TEXT);
});
