import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { migrateAutomationWorkflowDefinition, validateAutomationWorkflowDefinition, type AutomationWorkflowDefinition } from "./automation-workflow";

function validDefinition(): AutomationWorkflowDefinition {
  const trigger = randomUUID(); const condition = randomUUID(); const yes = randomUUID(); const no = randomUUID();
  return {
    schemaVersion: 1,
    name: "Responder un nuevo mensaje",
    nodes: [
      { id: trigger, type: "trigger.event", position: { x: 80, y: 100 }, config: { eventType: "message.received" } },
      { id: condition, type: "condition.if", position: { x: 330, y: 100 }, config: { field: "message.channel", operator: "equals", value: "messenger" } },
      { id: yes, type: "flow.end", position: { x: 600, y: 60 }, config: { outcome: "complete" } },
      { id: no, type: "flow.end", position: { x: 600, y: 170 }, config: { outcome: "stop" } },
    ],
    edges: [
      { id: randomUUID(), source: trigger, sourcePort: "next", target: condition, targetPort: "in" },
      { id: randomUUID(), source: condition, sourcePort: "true", target: yes, targetPort: "in" },
      { id: randomUUID(), source: condition, sourcePort: "false", target: no, targetPort: "in" },
    ],
  };
}

test("accepts a versioned graph with explicit condition branches and terminal nodes", () => {
  const definition = validDefinition();
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);
  assert.deepEqual(migrateAutomationWorkflowDefinition(definition), definition);
});

test("requires one trigger and at least one terminal node", () => {
  const definition = validDefinition();
  definition.nodes = definition.nodes.filter((node) => node.type !== "trigger.event" && node.type !== "flow.end");
  const codes = validateAutomationWorkflowDefinition(definition).map((issue) => issue.code);
  assert.ok(codes.includes("missing_trigger"));
  assert.ok(codes.includes("missing_end"));
});

test("rejects multiple event triggers in a workflow", () => {
  const definition = validDefinition();
  definition.nodes.push({ id: randomUUID(), type: "trigger.event", position: { x: 0, y: 300 }, config: { eventType: "contact.created" } });
  assert.ok(validateAutomationWorkflowDefinition(definition).some((issue) => issue.code === "multiple_triggers"));
});

test("identifies unconnected and unreachable nodes before activation", () => {
  const definition = validDefinition();
  const orphan = randomUUID();
  definition.nodes.push({ id: orphan, type: "flow.end", position: { x: 700, y: 300 }, config: { outcome: "complete" } });
  assert.ok(validateAutomationWorkflowDefinition(definition).some((issue) => issue.code === "orphan_node" && issue.nodeId === orphan));
});

test("requires both true and false condition outputs to be connected", () => {
  const definition = validDefinition();
  definition.edges = definition.edges.filter((edge) => edge.sourcePort !== "false");
  assert.ok(validateAutomationWorkflowDefinition(definition).some((issue) => issue.code === "missing_branch"));
});

test("rejects cycles", () => {
  const definition = validDefinition();
  const trigger = definition.nodes.find((node) => node.type === "trigger.event")!;
  const end = definition.nodes.find((node) => node.type === "flow.end")!;
  definition.edges.push({ id: randomUUID(), source: end.id, sourcePort: "next", target: trigger.id, targetPort: "in" });
  assert.ok(validateAutomationWorkflowDefinition(definition).some((issue) => issue.code === "cycle"));
});

test("rejects unsupported node types, event names, operators, and unsafe positions", () => {
  const definition = validDefinition() as unknown as { schemaVersion: number; name: string; nodes: Array<Record<string, unknown>>; edges: unknown[] };
  definition.nodes[0] = { ...definition.nodes[0], type: "action.http_request" };
  definition.nodes[1] = { ...definition.nodes[1], position: { x: Number.POSITIVE_INFINITY, y: -1 } };
  const issues = validateAutomationWorkflowDefinition(definition);
  assert.ok(issues.some((issue) => issue.code === "invalid_node"));
  assert.ok(issues.some((issue) => issue.code === "invalid_position"));
});

test("rejects a future schema version until a migrator is defined", () => {
  const definition = { ...validDefinition(), schemaVersion: 2 };
  assert.ok(validateAutomationWorkflowDefinition(definition).some((issue) => issue.code === "unsupported_version"));
  assert.throws(() => migrateAutomationWorkflowDefinition(definition), /migración no disponible/);
});
