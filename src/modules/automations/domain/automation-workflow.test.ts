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

test("validates Switch cases and requires one connection for every case and the default", () => {
  const definition = validDefinition();
  const switchId = randomUUID(); const caseOne = randomUUID(); const caseTwo = randomUUID();
  definition.nodes = definition.nodes.map((node) => node.type === "condition.if"
    ? { id: node.id, type: "condition.switch" as const, position: node.position, config: { field: "message.channel" as const, cases: [{ id: caseOne, value: "messenger" }, { id: caseTwo, value: "sms" }] } }
    : node);
  const condition = definition.nodes.find((node) => node.type === "condition.switch")!;
  const ends = definition.nodes.filter((node) => node.type === "flow.end");
  const defaultEnd = { id: randomUUID(), type: "flow.end" as const, position: { x: 900, y: 280 }, config: { outcome: "stop" as const } };
  definition.nodes.push(defaultEnd);
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id);
  definition.edges.push(
    { id: randomUUID(), source: condition.id, sourcePort: `case:${caseOne}`, target: ends[0]!.id, targetPort: "in" },
    { id: randomUUID(), source: condition.id, sourcePort: `case:${caseTwo}`, target: ends[1]!.id, targetPort: "in" },
    { id: randomUUID(), source: condition.id, sourcePort: "default", target: defaultEnd.id, targetPort: "in" },
  );
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);
  definition.edges = definition.edges.filter((edge) => edge.sourcePort !== `case:${caseTwo}`);
  assert.ok(validateAutomationWorkflowDefinition(definition).some((issue) => issue.code === "missing_branch" && issue.nodeId === condition.id));
  const duplicateCases = { ...definition, nodes: definition.nodes.map((node) => node.type === "condition.switch" ? { ...node, config: { ...node.config, cases: node.config.cases.map((item) => ({ ...item, value: "same" })) } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(duplicateCases).some((issue) => issue.code === "invalid_node" && issue.nodeId === condition.id));
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

test("accepts durable wait nodes only with a bounded integer duration", () => {
  const definition = validDefinition();
  const trigger = definition.nodes.find((node) => node.type === "trigger.event")!;
  const condition = definition.nodes.find((node) => node.type === "condition.if")!;
  const yesEnd = definition.nodes.find((node) => node.type === "flow.end" && node.config.outcome === "complete")!;
  const waitId = randomUUID();
  definition.nodes.push({ id: waitId, type: "flow.wait", position: { x: 500, y: 20 }, config: { durationSeconds: 60 } });
  const yesEdge = definition.edges.find((edge) => edge.source === condition.id && edge.sourcePort === "true")!;
  yesEdge.target = waitId;
  definition.edges.push({ id: randomUUID(), source: waitId, sourcePort: "next", target: yesEnd.id, targetPort: "in" });
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);
  const invalid = { ...definition, nodes: definition.nodes.map((node) => node.id === waitId ? { ...node, config: { durationSeconds: 0 } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalid).some((issue) => issue.code === "invalid_node" && issue.nodeId === waitId));
  void trigger;
});

test("accepts opportunity stage actions and rejects unsupported stages", () => {
  const definition = validDefinition();
  const condition = definition.nodes.find((node) => node.type === "condition.if")!;
  const yesEnd = definition.nodes.find((node) => node.type === "flow.end" && node.config.outcome === "complete")!;
  const actionId = randomUUID();
  definition.nodes.push({ id: actionId, type: "opportunity.update_stage", position: { x: 500, y: 30 }, config: { stage: "working" } });
  const yesEdge = definition.edges.find((edge) => edge.source === condition.id && edge.sourcePort === "true")!;
  yesEdge.target = actionId;
  definition.edges.push({ id: randomUUID(), source: actionId, sourcePort: "next", target: yesEnd.id, targetPort: "in" });
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);

  const invalid = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { stage: "unknown" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalid).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
});

test("accepts contact tag actions only on contact event triggers", () => {
  const definition = validDefinition();
  const trigger = definition.nodes.find((node) => node.type === "trigger.event")!;
  const condition = definition.nodes.find((node) => node.type === "condition.if")!;
  const end = definition.nodes.find((node) => node.type === "flow.end" && node.config.outcome === "complete")!;
  const actionId = randomUUID();
  definition.nodes.push({ id: actionId, type: "contact.manage_tag", position: { x: 500, y: 30 }, config: { action: "add", tag: "seguimiento" } });
  const trueEdge = definition.edges.find((edge) => edge.source === condition.id && edge.sourcePort === "true")!;
  trueEdge.target = actionId;
  definition.edges.push({ id: randomUUID(), source: actionId, sourcePort: "next", target: end.id, targetPort: "in" });
  assert.ok(validateAutomationWorkflowDefinition(definition).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
  const contactTrigger = { ...trigger, config: { eventType: "contact.created" as const } };
  definition.nodes = definition.nodes.map((node) => node.id === trigger.id ? contactTrigger : node);
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);
  const invalid = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { action: "merge", tag: "" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalid).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
});

test("accepts contact field updates only for allowlisted fields and bounded values", () => {
  const definition = validDefinition();
  const trigger = definition.nodes.find((node) => node.type === "trigger.event")!;
  const condition = definition.nodes.find((node) => node.type === "condition.if")!;
  const end = definition.nodes.find((node) => node.type === "flow.end" && node.config.outcome === "complete")!;
  const actionId = randomUUID();
  definition.nodes.push({ id: actionId, type: "contact.update_field", position: { x: 500, y: 30 }, config: { field: "preferredLanguage", value: "es" } });
  const triggerEdge = definition.edges.find((edge) => edge.source === trigger.id)!;
  triggerEdge.target = actionId;
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id || edge.sourcePort !== "true");
  definition.edges.push({ id: randomUUID(), source: actionId, sourcePort: "next", target: end.id, targetPort: "in" });
  definition.nodes = definition.nodes.filter((node) => node.id !== condition.id && node.id !== definition.nodes.find((item) => item.type === "flow.end" && item.config.outcome === "stop")?.id);
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id && edge.target !== condition.id && definition.nodes.some((node) => node.id === edge.source) && definition.nodes.some((node) => node.id === edge.target));
  const contactTrigger = { ...trigger, config: { eventType: "contact.updated" as const } };
  definition.nodes = definition.nodes.map((node) => node.id === trigger.id ? contactTrigger : node);
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);
  const invalid = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { field: "consentState", value: "granted" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalid).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
  const invalidLanguage = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { field: "preferredLanguage", value: "not a locale" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalidLanguage).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
});

test("accepts conversation assignment only for conversation events and valid dealer user IDs", () => {
  const definition = validDefinition();
  const trigger = definition.nodes.find((node) => node.type === "trigger.event")!;
  const condition = definition.nodes.find((node) => node.type === "condition.if")!;
  const end = definition.nodes.find((node) => node.type === "flow.end" && node.config.outcome === "complete")!;
  const actionId = randomUUID();
  definition.nodes.push({ id: actionId, type: "conversation.assign", position: { x: 500, y: 30 }, config: { assignedUserId: randomUUID() } });
  const triggerEdge = definition.edges.find((edge) => edge.source === trigger.id)!;
  triggerEdge.target = actionId;
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id || edge.sourcePort !== "true");
  definition.edges.push({ id: randomUUID(), source: actionId, sourcePort: "next", target: end.id, targetPort: "in" });
  definition.nodes = definition.nodes.filter((node) => node.id !== condition.id && !(node.type === "flow.end" && node.config.outcome === "stop"));
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id && edge.target !== condition.id && definition.nodes.some((node) => node.id === edge.source) && definition.nodes.some((node) => node.id === edge.target));
  const conversationTrigger = { ...trigger, config: { eventType: "conversation.assigned" as const } };
  definition.nodes = definition.nodes.map((node) => node.id === trigger.id ? conversationTrigger : node);
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);
  const invalidTrigger = { ...definition, nodes: definition.nodes.map((node) => node.type === "trigger.event" ? { ...node, config: { eventType: "message.received" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalidTrigger).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
  const invalidAssignee = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { assignedUserId: "not-a-uuid" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalidAssignee).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
  const unassign = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { assignedUserId: null } } : node) };
  assert.deepEqual(validateAutomationWorkflowDefinition(unassign), []);
});

test("accepts opportunity assignment only for opportunity events and valid dealer user IDs", () => {
  const definition = validDefinition();
  const trigger = definition.nodes.find((node) => node.type === "trigger.event")!;
  const condition = definition.nodes.find((node) => node.type === "condition.if")!;
  const end = definition.nodes.find((node) => node.type === "flow.end" && node.config.outcome === "complete")!;
  const actionId = randomUUID();
  definition.nodes.push({ id: actionId, type: "opportunity.assign", position: { x: 500, y: 30 }, config: { assignedUserId: randomUUID() } });
  definition.edges.find((edge) => edge.source === trigger.id)!.target = actionId;
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id);
  definition.edges.push({ id: randomUUID(), source: actionId, sourcePort: "next", target: end.id, targetPort: "in" });
  definition.nodes = definition.nodes.filter((node) => node.id !== condition.id && !(node.type === "flow.end" && node.config.outcome === "stop"));
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id && edge.target !== condition.id && definition.nodes.some((node) => node.id === edge.source) && definition.nodes.some((node) => node.id === edge.target));
  definition.nodes = definition.nodes.map((node) => node.id === trigger.id ? { ...trigger, config: { eventType: "opportunity.assigned" } } : node);
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);
  const invalidTrigger = { ...definition, nodes: definition.nodes.map((node) => node.type === "trigger.event" ? { ...node, config: { eventType: "message.received" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalidTrigger).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
  const invalidAssignee = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { assignedUserId: "not-a-uuid" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalidAssignee).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
  const unassign = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { assignedUserId: null } } : node) };
  assert.deepEqual(validateAutomationWorkflowDefinition(unassign), []);
});

test("accepts appointment status actions only for appointment events and known statuses", () => {
  const definition = validDefinition();
  const trigger = definition.nodes.find((node) => node.type === "trigger.event")!;
  const condition = definition.nodes.find((node) => node.type === "condition.if")!;
  const end = definition.nodes.find((node) => node.type === "flow.end" && node.config.outcome === "complete")!;
  const actionId = randomUUID();
  definition.nodes.push({ id: actionId, type: "appointment.update_status", position: { x: 500, y: 30 }, config: { status: "confirmed" } });
  definition.edges.find((edge) => edge.source === trigger.id)!.target = actionId;
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id);
  definition.edges.push({ id: randomUUID(), source: actionId, sourcePort: "next", target: end.id, targetPort: "in" });
  definition.nodes = definition.nodes.filter((node) => node.id !== condition.id && !(node.type === "flow.end" && node.config.outcome === "stop"));
  definition.edges = definition.edges.filter((edge) => edge.source !== condition.id && edge.target !== condition.id && definition.nodes.some((node) => node.id === edge.source) && definition.nodes.some((node) => node.id === edge.target));
  definition.nodes = definition.nodes.map((node) => node.id === trigger.id ? { ...trigger, config: { eventType: "appointment.status_changed" } } : node);
  assert.deepEqual(validateAutomationWorkflowDefinition(definition), []);
  const invalidTrigger = { ...definition, nodes: definition.nodes.map((node) => node.type === "trigger.event" ? { ...node, config: { eventType: "message.received" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalidTrigger).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
  const invalidStatus = { ...definition, nodes: definition.nodes.map((node) => node.id === actionId ? { ...node, config: { status: "invalid" } } : node) };
  assert.ok(validateAutomationWorkflowDefinition(invalidStatus).some((issue) => issue.code === "invalid_node" && issue.nodeId === actionId));
});
