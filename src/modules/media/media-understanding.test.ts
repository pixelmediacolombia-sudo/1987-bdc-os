import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichInboundMedia } from "@/modules/media/application/enrich-inbound-media";
import { FixtureMediaUnderstandingAdapter } from "@/modules/media/application/fixture-media-understanding.adapter";
import { AUDIO_TEXT, fixtureAdapter } from "@/modules/media/media-test-fixtures";
import { parseGhlWebhookPayload } from "@/modules/webhooks/domain/ghl-webhook.parser";

test("parsea un inbound multimedia sin perder el canal ni el contacto", () => {
  const event = parseGhlWebhookPayload({
    eventId: "media-inbound-1",
    eventType: "InboundMessage",
    locationId: "location-media-test",
    direction: "inbound",
    contactId: "contact-media-test",
    messageType: "WhatsApp",
    message: {
      attachments: [
        { type: "audio/mpeg", filename: "family-suv.wav", url: "https://example.test/family-suv.wav" },
        { mimeType: "image/svg+xml", filename: "qualification-signals.svg", url: "https://example.test/qualification-signals.svg" },
      ],
    },
  }, Buffer.from("media-inbound-1"), "signature");

  assert.equal(event.inboundMessage?.contactId, "contact-media-test");
  assert.equal(event.inboundMessage?.channel, "whatsapp");
  assert.equal(event.inboundMessage?.attachments?.map((item) => item.kind).join(","), "audio,image");
  assert.match(event.inboundMessage?.content ?? "", /Adjunto de audio/);
});

test("acepta también un adjunto singular dentro del mensaje", () => {
  const event = parseGhlWebhookPayload({
    eventId: "media-inbound-single",
    eventType: "InboundMessage",
    locationId: "location-media-test",
    direction: "inbound",
    contactId: "contact-media-test",
    messageType: "Instagram",
    message: { type: "image", url: "https://example.test/image.jpg", filename: "single-image.jpg" },
  }, Buffer.from("media-inbound-single"), "signature");
  assert.equal(event.inboundMessage?.attachments?.[0]?.kind, "image");
  assert.equal(event.inboundMessage?.attachments?.[0]?.filename, "single-image.jpg");
});

test("enriquece audio pero nunca agrega OCR de imagen al texto persistible", async () => {
  const event = parseGhlWebhookPayload({
    eventId: "media-inbound-2",
    eventType: "InboundMessage",
    locationId: "location-media-test",
    direction: "inbound",
    contactId: "contact-media-test",
    messageType: "WhatsApp",
    message: {
      body: "Te comparto la información.",
      attachments: [
        { type: "audio/wav", filename: "family-suv.wav", localPath: "fixtures/media/family-suv.wav" },
        { type: "image/svg+xml", filename: "qualification-signals.svg", localPath: "fixtures/media/qualification-signals.svg" },
      ],
    },
  }, Buffer.from("media-inbound-2"), "signature");

  const enriched = await enrichInboundMedia(event, fixtureAdapter(), { info: () => undefined, error: () => undefined });
  assert.match(enriched.inboundMessage?.content ?? "", /^Te comparto la información\./);
  assert.match(enriched.inboundMessage?.content ?? "", new RegExp(AUDIO_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(enriched.inboundMessage?.content ?? "", /Busco una SUV para mi familia|Enganche disponible/);
  assert.deepEqual(enriched.inboundMessage?.mediaSignals, { imageClassifications: ["unrelated"] });
});

test("un audio vacío activa la aclaración sin inventar texto del cliente", async () => {
  const event = parseGhlWebhookPayload({
    eventId: "media-inbound-empty-audio",
    eventType: "InboundMessage",
    locationId: "location-media-test",
    direction: "inbound",
    contactId: "contact-media-test",
    messageType: "WhatsApp",
    message: { attachments: [{ type: "audio/wav", filename: "empty.wav", localPath: "fixtures/media/empty.wav" }] },
  }, Buffer.from("media-inbound-empty-audio"), "signature");
  const enriched = await enrichInboundMedia(event, new FixtureMediaUnderstandingAdapter({
    "empty.wav": { kind: "audio", text: "", source: "fixture" },
  }), { info: () => undefined, error: () => undefined });
  assert.equal(enriched.inboundMessage?.content, "Adjunto de audio");
  assert.deepEqual(enriched.inboundMessage?.mediaSignals, { audioTranscriptionFailed: true });
});

test("si el adaptador local no está habilitado no rompe el webhook", async () => {
  const event = parseGhlWebhookPayload({
    eventId: "media-inbound-3",
    eventType: "InboundMessage",
    locationId: "location-media-test",
    direction: "inbound",
    contactId: "contact-media-test",
    messageType: "Instagram",
    message: { attachments: [{ type: "audio/wav", filename: "family-suv.wav", url: "https://example.test/family-suv.wav" }] },
  }, Buffer.from("media-inbound-3"), "signature");
  const enriched = await enrichInboundMedia(event, undefined);
  assert.equal(enriched.inboundMessage?.channel, "ig");
  assert.match(enriched.inboundMessage?.content ?? "", /Adjunto de audio/);
});
