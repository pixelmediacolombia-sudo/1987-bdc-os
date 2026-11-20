import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichInboundMedia } from "@/modules/media/application/enrich-inbound-media";
import { FixtureMediaUnderstandingAdapter } from "@/modules/media/application/fixture-media-understanding.adapter";
import { AUDIO_TEXT, fixtureAdapter } from "@/modules/media/media-test-fixtures";
import type { InboundWebhookEvent, MediaAttachment } from "@/modules/webhooks/domain/inbound-webhook-event";

function mediaEvent(input: {
  id: string;
  channel?: string;
  content?: string;
  attachments?: MediaAttachment[];
}): InboundWebhookEvent {
  const message = {
    externalId: input.id,
    contactId: "contact-media-test",
    conversationId: `media:${input.id}`,
    channel: input.channel ?? "whatsapp",
    content: input.content ?? "",
    semanticHash: `hash:${input.id}`,
    ...(input.attachments ? { attachments: input.attachments } : {}),
  };
  return {
    provider: "meta",
    externalId: input.id,
    eventType: "meta.message.received",
    accountId: "account-media-test",
    signature: "test-signature",
    rawBody: Buffer.from(input.id),
    payload: { object: "whatsapp_business_account" },
    contactId: message.contactId,
    conversationId: message.conversationId,
    inboundMessage: message,
  };
}

test("enriquece audio pero nunca agrega OCR de imagen al texto persistible", async () => {
  const event = mediaEvent({
    id: "media-inbound-2",
    content: "Te comparto la información.",
    attachments: [
      { kind: "audio", filename: "family-suv.wav", localPath: "fixtures/media/family-suv.wav" },
      { kind: "image", filename: "qualification-signals.svg", localPath: "fixtures/media/qualification-signals.svg" },
    ],
  });
  const enriched = await enrichInboundMedia(event, fixtureAdapter(), { info: () => undefined, error: () => undefined });
  assert.match(enriched.inboundMessage?.content ?? "", /^Te comparto la información\./);
  assert.match(enriched.inboundMessage?.content ?? "", new RegExp(AUDIO_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(enriched.inboundMessage?.content ?? "", /Busco una SUV para mi familia|Enganche disponible/);
  assert.deepEqual(enriched.inboundMessage?.mediaSignals, { imageClassifications: ["unrelated"] });
});

test("un audio vacío activa la aclaración sin inventar texto del cliente", async () => {
  const enriched = await enrichInboundMedia(mediaEvent({
    id: "media-inbound-empty-audio",
    attachments: [{ kind: "audio", filename: "empty.wav", localPath: "fixtures/media/empty.wav" }],
  }), new FixtureMediaUnderstandingAdapter({
    "empty.wav": { kind: "audio", text: "", source: "fixture" },
  }), { info: () => undefined, error: () => undefined });
  assert.equal(enriched.inboundMessage?.content, "Adjunto de audio");
  assert.deepEqual(enriched.inboundMessage?.mediaSignals, { audioTranscriptionFailed: true });
});

test("transporta la categoría de vehículo identificada en imagen sin transportar OCR", async () => {
  const enriched = await enrichInboundMedia(mediaEvent({
    id: "media-inbound-vehicle-category",
    attachments: [{ kind: "image", filename: "vehicle.svg", localPath: "fixtures/media/vehicle.svg" }],
  }), new FixtureMediaUnderstandingAdapter({
    "vehicle.svg": { kind: "image", classification: "vehicle_photo", vehicleCategory: "SUV", source: "fixture", text: "OCR must not enter content" },
  }), { info: () => undefined, error: () => undefined });
  assert.deepEqual(enriched.inboundMessage?.mediaSignals, {
    imageClassifications: ["vehicle_photo"],
    imageVehicleCategories: ["suv"],
  });
  assert.doesNotMatch(enriched.inboundMessage?.content ?? "", /OCR must not enter content/);
});

test("si el adaptador local no está habilitado, el webhook conserva el canal y no falla", async () => {
  const enriched = await enrichInboundMedia(mediaEvent({
    id: "media-inbound-3",
    channel: "ig",
    attachments: [{ kind: "audio", filename: "family-suv.wav", url: "https://example.test/family-suv.wav" }],
  }), undefined);
  assert.equal(enriched.inboundMessage?.channel, "ig");
  assert.match(enriched.inboundMessage?.content ?? "", /Adjunto de audio/);
});
