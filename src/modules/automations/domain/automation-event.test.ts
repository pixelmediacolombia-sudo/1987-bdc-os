import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidAutomationEventError, parseAutomationEvent } from "@/modules/automations/domain/automation-event";

const baseEvent = {
  schemaVersion: 1,
  eventId: "8a50b329-02d7-4e0b-9839-1bc1854be762",
  tenantId: "6c4e47a3-73b6-4356-9dd4-6279b905ba49",
  type: "message.received",
  occurredAt: "2026-11-26T19:00:00.000Z",
  origin: "meta_webhook",
  actor: { type: "contact", id: "14f9e76d-77bb-43df-b8c4-63e3ef9b4f9f" },
  entity: { type: "message", id: "38064bfa-f3ed-47f3-8e30-01918b4ce014" },
  payload: {
    conversationId: "b4442a34-d4d5-4c50-8ff8-c1cdbd99a4a2",
    contactId: "14f9e76d-77bb-43df-b8c4-63e3ef9b4f9f",
    channel: "whatsapp",
    senderType: "client",
  },
};

test("accepts a versioned message event with bounded, tenant-scoped references", () => {
  const event = parseAutomationEvent(baseEvent);
  assert.equal(event.type, "message.received");
  if (event.type === "message.received") assert.equal(event.payload.contactId, baseEvent.payload.contactId);
});

test("accepts an opportunity stage transition with explicit before and after values", () => {
  const event = parseAutomationEvent({
    ...baseEvent,
    type: "opportunity.stage_changed",
    entity: { type: "opportunity", id: "9d8753e1-91e3-4fa1-a1cb-4e642696329c" },
    payload: {
      contactId: baseEvent.payload.contactId,
      previousStage: "new",
      stage: "qualified",
    },
  });
  assert.equal(event.type, "opportunity.stage_changed");
  if (event.type === "opportunity.stage_changed") assert.equal(event.payload.previousStage, "new");
});

test("rejects unsupported schema versions and event types", () => {
  assert.throws(() => parseAutomationEvent({ ...baseEvent, schemaVersion: 2 }), InvalidAutomationEventError);
  assert.throws(() => parseAutomationEvent({ ...baseEvent, type: "workflow.run" }), InvalidAutomationEventError);
});

test("rejects entity mismatches and malformed tenant identifiers", () => {
  assert.throws(() => parseAutomationEvent({ ...baseEvent, entity: { type: "conversation", id: baseEvent.entity.id } }), /Entity type or ID/);
  assert.throws(() => parseAutomationEvent({ ...baseEvent, tenantId: "dealer-a" }), /UUIDs/);
});

test("rejects arbitrary message text and unknown payload fields", () => {
  assert.throws(() => parseAutomationEvent({
    ...baseEvent,
    payload: { ...baseEvent.payload, content: "customer private message" },
  }), /unsupported field content/);
});

test("rejects invalid IDs, timestamps, and nested payload values", () => {
  assert.throws(() => parseAutomationEvent({
    ...baseEvent,
    payload: { ...baseEvent.payload, contactId: "not-a-uuid" },
  }), /must be a UUID/);
  assert.throws(() => parseAutomationEvent({ ...baseEvent, occurredAt: "yesterday" }), /ISO date-time/);
  assert.throws(() => parseAutomationEvent({
    ...baseEvent,
    payload: { ...baseEvent.payload, channel: { name: "whatsapp" } },
  }), /bounded string/);
});

test("requires all fields declared for the event kind", () => {
  assert.throws(() => parseAutomationEvent({
    ...baseEvent,
    payload: { conversationId: baseEvent.payload.conversationId, contactId: baseEvent.payload.contactId },
  }), /payload.channel is required/);
});
