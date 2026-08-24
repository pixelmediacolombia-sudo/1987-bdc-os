import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCtwaAttribution } from "@/modules/webhooks/domain/ctwa-clid";
import { parseGhlWebhookPayload } from "@/modules/webhooks/domain/ghl-webhook.parser";

test("Ticket 8.5 extracts ctwa_clid from WhatsApp referral variants", () => {
  const result = extractCtwaAttribution({
    data: {
      message: {
        referral: { ctwa_clid: " click-123 ", source_id: "source-456" },
      },
    },
  });
  assert.deepEqual(result, { ctwaClid: "click-123", sourceId: "source-456" });
});

test("Ticket 8.5 carries attribution on the inbound message without changing raw payload", () => {
  const payload = {
    locationId: "location-1",
    eventType: "InboundMessage",
    eventId: "event-1",
    contactId: "contact-1",
    direction: "inbound",
    message: {
      content: "Hola",
      referral: { ctwaClid: "click-789" },
    },
  };
  const event = parseGhlWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "sig");
  assert.equal(event.inboundMessage?.ctwaClid, "click-789");
  assert.deepEqual((event.payload.message as { referral: { ctwaClid: string } }).referral, { ctwaClid: "click-789" });
});
