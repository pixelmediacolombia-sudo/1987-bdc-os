import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCtwaAttribution } from "@/modules/webhooks/domain/ctwa-clid";
import { parseMetaWebhookPayload } from "@/features/meta/domain/meta-webhook.parser";

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
  const payload = { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ value: {
    metadata: { phone_number_id: "phone-1" },
    messages: [{ id: "wamid-1", from: "contact-1", type: "text", text: { body: "Hola" }, referral: { ctwa_clid: "click-789" } }],
  } }] }] };
  const event = parseMetaWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "sig")[0]!;
  assert.equal(event.inboundMessage?.ctwaClid, "click-789");
  const rawEntry = event.payload.entry as Array<{ changes: Array<{ value: { messages: Array<{ referral: { ctwa_clid: string } }> } }> }>;
  assert.deepEqual(rawEntry[0]?.changes[0]?.value.messages[0]?.referral, { ctwa_clid: "click-789" });
});
