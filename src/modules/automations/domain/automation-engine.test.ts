import assert from "node:assert/strict";
import test from "node:test";
import { calculateAutomationBackoff, evaluateAutomationCondition, findAutomationNextNode } from "./automation-engine";
import type { AutomationEvent } from "./automation-event";
import type { AutomationWorkflowDefinition } from "./automation-workflow";

const event: AutomationEvent = {
  schemaVersion: 1, eventId: "00000000-0000-4000-8000-000000000001", tenantId: "00000000-0000-4000-8000-000000000002",
  type: "message.received", occurredAt: "2026-11-26T14:00:00.000Z", origin: "meta_webhook", actor: { type: "contact" },
  entity: { type: "message", id: "00000000-0000-4000-8000-000000000003" },
  payload: { conversationId: "00000000-0000-4000-8000-000000000004", contactId: "00000000-0000-4000-8000-000000000005", channel: "Messenger", senderType: "client" },
};
const definition: AutomationWorkflowDefinition = {
  schemaVersion: 1, name: "Message channel test", nodes: [
    { id: "00000000-0000-4000-8000-000000000006", type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "message.received" } },
    { id: "00000000-0000-4000-8000-000000000007", type: "condition.if", position: { x: 1, y: 1 }, config: { field: "message.channel", operator: "equals", value: "messenger" } },
    { id: "00000000-0000-4000-8000-000000000008", type: "flow.end", position: { x: 2, y: 2 }, config: { outcome: "complete" } },
  ], edges: [
    { id: "10000000-0000-4000-8000-000000000001", source: "00000000-0000-4000-8000-000000000006", sourcePort: "next", target: "00000000-0000-4000-8000-000000000007", targetPort: "in" },
    { id: "10000000-0000-4000-8000-000000000002", source: "00000000-0000-4000-8000-000000000007", sourcePort: "true", target: "00000000-0000-4000-8000-000000000008", targetPort: "in" },
  ],
};

test("evaluates IF against allowlisted event fields with case-insensitive matching", () => {
  const condition = definition.nodes[1]!;
  assert.equal(condition.type, "condition.if");
  if (condition.type !== "condition.if") return;
  assert.deepEqual(evaluateAutomationCondition(event, condition), { matched: true, value: "Messenger" });
  const differentEvent: AutomationEvent = { ...event, type: "contact.created", entity: { type: "contact", id: event.entity.id }, payload: { source: "manual" } };
  assert.equal(evaluateAutomationCondition(differentEvent, condition).matched, false);
});

test("selects a connected branch and applies capped exponential retry backoff", () => {
  assert.equal(findAutomationNextNode(definition, "00000000-0000-4000-8000-000000000007", "true"), "00000000-0000-4000-8000-000000000008");
  assert.throws(() => findAutomationNextNode(definition, "00000000-0000-4000-8000-000000000007", "false"), /no tiene conectada/);
  assert.deepEqual([calculateAutomationBackoff(1), calculateAutomationBackoff(2), calculateAutomationBackoff(4), calculateAutomationBackoff(20)], [2, 4, 16, 300]);
});
