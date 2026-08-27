import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import type { Request, Response as ExpressResponse } from "express";
import type { GhlOAuthController } from "@/features/ghl-oauth/presentation/http/ghl-oauth.controller";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import type { SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import type { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { HydratedContext } from "@/modules/memory/domain/hydrated-context";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";
import { FixtureMediaUnderstandingAdapter } from "@/modules/media/application/fixture-media-understanding.adapter";
import { AUDIO_TEXT, IMAGE_TEXT, fixtureAdapter } from "@/modules/media/media-test-fixtures";
import { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import type { WebhookRepository } from "@/modules/webhooks/application/ports/webhook-repository.port";
import type { WebhookProcessResult } from "@/modules/webhooks/application/ports/webhook-repository.port";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";
import { WebhookController } from "@/modules/webhooks/presentation/http/webhook.controller";
import { createHttpApp } from "@/presentation/http/create-http-app";

const TENANT_ID = "dealer-media-e2e";
const CONTACT_ID = "contact-media-e2e";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signatureKeys = {
  ed25519PublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  legacyRsaPublicKey: "invalid-test-key",
};

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
  contact: { id: CONTACT_ID, ghlContactId: CONTACT_ID, preferredLanguage: "es", consentState: "granted" },
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

async function postSignedWebhook(useCase: ProcessGHLWebhookUseCase, payload: object): Promise<globalThis.Response> {
  const body = JSON.stringify(payload);
  const oauthController = {
    initiateHandler: (_req: Request, res: ExpressResponse) => res.status(404).end(),
    completeHandler: (_req: Request, res: ExpressResponse) => res.status(404).end(),
  } as unknown as GhlOAuthController;
  const app = createHttpApp(oauthController, new WebhookController(useCase), signatureKeys);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Media E2E server did not bind a port");
  try {
    return await fetch(`http://127.0.0.1:${address.port}/webhooks/ghl`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ghl-signature": sign(null, Buffer.from(body, "utf8"), privateKey).toString("base64"),
      },
      body,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
    { engine: new SofiaConversationEngine(), repository: stateRepository, dealerName: "Country Club Cars Inc." },
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
  const useCase = new ProcessGHLWebhookUseCase(repository, burstBuffer, undefined, undefined, undefined, fixtureAdapter());

  const audioResponse = await postSignedWebhook(useCase, {
      eventId: "media-e2e-audio",
      eventType: "InboundMessage",
      locationId: "location-media-e2e",
      direction: "inbound",
      contactId: CONTACT_ID,
      messageType: "WhatsApp",
      message: { attachments: [{ type: "audio/wav", filename: "family-suv.wav", localPath: "fixtures/media/family-suv.wav" }] },
  });
  assert.equal(audioResponse.status, 200);
  for (let attempt = 0; attempt < 20 && responses.length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  const imageResponse = await postSignedWebhook(useCase, {
      eventId: "media-e2e-image",
      eventType: "InboundMessage",
      locationId: "location-media-e2e",
      direction: "inbound",
      contactId: CONTACT_ID,
      messageType: "WhatsApp",
      message: { attachments: [{ type: "image/svg+xml", filename: "qualification-signals.svg", localPath: "fixtures/media/qualification-signals.svg" }] },
  });
  assert.equal(imageResponse.status, 200);
  for (let attempt = 0; attempt < 20 && responses.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(repository.persisted.length, 2);
  assert.match(repository.persisted[0] ?? "", new RegExp(AUDIO_TEXT.slice(0, 35).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(repository.persisted[1], "Adjunto de image");
  assert.doesNotMatch(repository.persisted[1] ?? "", /Busco una SUV|Enganche disponible/);
  assert.equal(responses.length, 2);
  assert.ok(responses.every((response) => response.trim().length > 0));
  assert.equal(savedState?.turnCount, 2);
  assert.equal(responses[0], "Hola! Te saludamos desde Country Club Cars Inc.. Soy Sofía.\nPerfecto, para familia la SUV es buena opción. ¿Con cuánto cuentas para el enganche?");
  assert.equal(responses[1], "Gracias por compartirla. Seguimos con la información de tu compra.\n¿Con cuánto cuentas para el enganche?");
  console.log(`MEDIA_E2E_RESPONSES audio=${JSON.stringify(responses[0])} image=${JSON.stringify(responses[1])}`);
  assert.equal(typeof IMAGE_TEXT, "string");
});

test("el adaptador de fixtures no se confunde con el proveedor local", async () => {
  const adapter = new FixtureMediaUnderstandingAdapter({
    "family-suv.wav": { kind: "audio", text: AUDIO_TEXT, source: "fixture" },
  });
  const result = await adapter.understand({ kind: "audio", filename: "family-suv.wav", localPath: "fixtures/media/family-suv.wav" });
  assert.equal(result.source, "fixture");
  assert.equal(result.text, AUDIO_TEXT);
});
