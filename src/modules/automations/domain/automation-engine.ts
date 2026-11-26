import type { AutomationEvent } from "./automation-event";
import type { AutomationWorkflowDefinition, AutomationWorkflowNode } from "./automation-workflow";

export type AutomationConditionResult = { matched: boolean; value: string | null };

export function findAutomationNode(definition: AutomationWorkflowDefinition, nodeId: string): AutomationWorkflowNode {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error("El workflow apunta a un nodo que no existe.");
  return node;
}

export function findAutomationNextNode(definition: AutomationWorkflowDefinition, nodeId: string, port: "next" | "true" | "false"): string {
  const edge = definition.edges.find((candidate) => candidate.source === nodeId && candidate.sourcePort === port);
  if (!edge) throw new Error("El workflow no tiene conectada la salida seleccionada.");
  return edge.target;
}

export function evaluateAutomationCondition(event: AutomationEvent, node: Extract<AutomationWorkflowNode, { type: "condition.if" }>): AutomationConditionResult {
  const value = readConditionValue(event, node.config.field);
  const normalized = value?.toLocaleLowerCase("en-US") ?? null;
  const expected = node.config.value?.toLocaleLowerCase("en-US") ?? "";
  switch (node.config.operator) {
    case "equals": return { matched: normalized !== null && normalized === expected, value };
    case "not_equals": return { matched: normalized !== null && normalized !== expected, value };
    case "contains": return { matched: normalized !== null && normalized.includes(expected), value };
    case "is_empty": return { matched: normalized === null || normalized.trim() === "", value };
    case "is_not_empty": return { matched: normalized !== null && normalized.trim() !== "", value };
  }
}

export function automationRunStartNode(definition: AutomationWorkflowDefinition, eventType: string): string | null {
  return definition.nodes.find((node) => node.type === "trigger.event" && node.config.eventType === eventType)?.id ?? null;
}

export function calculateAutomationBackoff(attempt: number, baseSeconds = 2, maxSeconds = 300): number {
  const safeAttempt = Math.min(Math.max(Math.trunc(attempt), 1), 16);
  return Math.min(maxSeconds, baseSeconds * (2 ** (safeAttempt - 1)));
}

function readConditionValue(event: AutomationEvent, field: string): string | null {
  switch (field) {
    case "event.type": return event.type;
    case "event.origin": return event.origin;
    case "contact.source": return event.type === "contact.created" ? event.payload.source : null;
    case "message.channel": return event.type === "message.received" || event.type === "message.sent" ? event.payload.channel : null;
    case "conversation.status": return event.type === "conversation.status_changed" ? event.payload.status : null;
    case "opportunity.stage": return event.type === "opportunity.created" || event.type === "opportunity.stage_changed" ? event.payload.stage : null;
    case "appointment.status": return event.type === "appointment.created" || event.type === "appointment.updated" || event.type === "appointment.status_changed" ? event.payload.status : null;
    default: return null;
  }
}
