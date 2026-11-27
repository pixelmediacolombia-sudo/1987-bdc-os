import { AUTOMATION_EVENT_TYPES, type AutomationEventType } from "./automation-event";

export const AUTOMATION_WORKFLOW_SCHEMA_VERSION = 1 as const;
export const AUTOMATION_WORKFLOW_NODE_TYPES = ["trigger.event", "condition.if", "condition.switch", "flow.wait", "opportunity.update_stage", "opportunity.assign", "appointment.update_status", "contact.manage_tag", "contact.update_field", "conversation.assign", "flow.end"] as const;
export type AutomationWorkflowNodeType = (typeof AUTOMATION_WORKFLOW_NODE_TYPES)[number];
export type AutomationWorkflowConditionField =
  | "event.type"
  | "event.origin"
  | "contact.source"
  | "message.channel"
  | "conversation.status"
  | "opportunity.stage"
  | "appointment.status";
export type AutomationWorkflowOperator = "equals" | "not_equals" | "contains" | "is_empty" | "is_not_empty";

export type AutomationWorkflowNode =
  | { id: string; type: "trigger.event"; position: { x: number; y: number }; config: { eventType: AutomationEventType } }
  | { id: string; type: "condition.if"; position: { x: number; y: number }; config: { field: AutomationWorkflowConditionField; operator: AutomationWorkflowOperator; value?: string } }
  | { id: string; type: "condition.switch"; position: { x: number; y: number }; config: { field: AutomationWorkflowConditionField; cases: Array<{ id: string; value: string }> } }
  | { id: string; type: "flow.wait"; position: { x: number; y: number }; config: { durationSeconds: number } }
  | { id: string; type: "opportunity.update_stage"; position: { x: number; y: number }; config: { stage: "new" | "working" | "closing" | "won" | "lost" } }
  | { id: string; type: "opportunity.assign"; position: { x: number; y: number }; config: { assignedUserId: string | null } }
  | { id: string; type: "appointment.update_status"; position: { x: number; y: number }; config: { status: "scheduled" | "confirmed" | "cancelled" | "completed" | "no_show" } }
  | { id: string; type: "contact.manage_tag"; position: { x: number; y: number }; config: { action: "add" | "remove"; tag: string } }
  | { id: string; type: "contact.update_field"; position: { x: number; y: number }; config: { field: "displayName" | "preferredLanguage"; value: string } }
  | { id: string; type: "conversation.assign"; position: { x: number; y: number }; config: { assignedUserId: string | null } }
  | { id: string; type: "flow.end"; position: { x: number; y: number }; config: { outcome: "complete" | "stop" } };

export type AutomationWorkflowEdge = {
  id: string;
  source: string;
  sourcePort: "next" | "true" | "false" | "default" | `case:${string}`;
  target: string;
  targetPort: "in";
};

export type AutomationWorkflowDefinition = {
  schemaVersion: typeof AUTOMATION_WORKFLOW_SCHEMA_VERSION;
  name: string;
  nodes: AutomationWorkflowNode[];
  edges: AutomationWorkflowEdge[];
};

export type AutomationWorkflowRevisionSet = {
  draft: { revision: number; definition: AutomationWorkflowDefinition; updatedAt: string };
  published: { revision: number; definition: AutomationWorkflowDefinition; publishedAt: string } | null;
};

export type AutomationWorkflowIssue = {
  code: "invalid_definition" | "unsupported_version" | "invalid_name" | "invalid_nodes" | "too_many_nodes"
    | "duplicate_node" | "invalid_node" | "invalid_position" | "duplicate_edge" | "invalid_edge"
    | "missing_trigger" | "multiple_triggers" | "missing_end" | "orphan_node" | "cycle"
    | "missing_branch" | "multiple_incoming";
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONDITION_FIELDS: readonly AutomationWorkflowConditionField[] = ["event.type", "event.origin", "contact.source", "message.channel", "conversation.status", "opportunity.stage", "appointment.status"];
const OPERATORS: readonly AutomationWorkflowOperator[] = ["equals", "not_equals", "contains", "is_empty", "is_not_empty"];
const MAX_NODES = 100;
const MAX_EDGES = 200;

/**
 * Checks the serializable v1 graph before it is saved or published. Incomplete
 * drafts can still be stored; any returned issue blocks publish in the editor.
 */
export function validateAutomationWorkflowDefinition(value: unknown): AutomationWorkflowIssue[] {
  if (!isRecord(value)) return [{ code: "invalid_definition", message: "El workflow debe ser un objeto." }];
  const issues: AutomationWorkflowIssue[] = [];
  if (value.schemaVersion !== AUTOMATION_WORKFLOW_SCHEMA_VERSION) {
    issues.push({ code: "unsupported_version", message: "La versión del workflow no es compatible.", path: "schemaVersion" });
  }
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 120) {
    issues.push({ code: "invalid_name", message: "El nombre debe tener entre 1 y 120 caracteres.", path: "name" });
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    issues.push({ code: "invalid_nodes", message: "El workflow debe incluir listas de nodos y conexiones." });
    return issues;
  }
  const nodes = value.nodes as unknown[];
  const edges = value.edges as unknown[];
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) {
    issues.push({ code: "too_many_nodes", message: `El workflow admite hasta ${MAX_NODES} nodos y ${MAX_EDGES} conexiones.` });
  }

  const byId = new Map<string, AutomationWorkflowNode>();
  for (const raw of nodes) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !UUID.test(raw.id)) {
      issues.push({ code: "invalid_node", message: "Cada nodo debe tener un ID válido." });
      continue;
    }
    if (byId.has(raw.id)) {
      issues.push({ code: "duplicate_node", message: "El ID del nodo está repetido.", nodeId: raw.id });
      continue;
    }
    if (!isRecord(raw.position) || !isFiniteCoordinate(raw.position.x) || !isFiniteCoordinate(raw.position.y)) {
      issues.push({ code: "invalid_position", message: "La posición del nodo no es válida.", nodeId: raw.id });
    }
    if (!isNodeConfigValid(raw)) {
      issues.push({ code: "invalid_node", message: "El tipo o la configuración del nodo no son compatibles con v1.", nodeId: raw.id });
      continue;
    }
    byId.set(raw.id, raw as unknown as AutomationWorkflowNode);
  }

  const triggers = [...byId.values()].filter((node) => node.type === "trigger.event");
  const ends = [...byId.values()].filter((node) => node.type === "flow.end");
  if (triggers.length === 0) issues.push({ code: "missing_trigger", message: "Añade un trigger de evento para iniciar el workflow." });
  if (triggers.length > 1) issues.push({ code: "multiple_triggers", message: "La versión inicial admite un solo trigger por workflow." });
  if (ends.length === 0) issues.push({ code: "missing_end", message: "Añade al menos un nodo de fin para cerrar cada ruta." });

  const outgoing = new Map<string, AutomationWorkflowEdge[]>();
  const incoming = new Map<string, AutomationWorkflowEdge[]>();
  const edgeIds = new Set<string>();
  for (const raw of edges) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !UUID.test(raw.id)) {
      issues.push({ code: "invalid_edge", message: "Cada conexión debe tener un ID válido." });
      continue;
    }
    if (edgeIds.has(raw.id)) issues.push({ code: "duplicate_edge", message: "El ID de la conexión está repetido.", edgeId: raw.id });
    edgeIds.add(raw.id);
    const source = typeof raw.source === "string" ? byId.get(raw.source) : undefined;
    const target = typeof raw.target === "string" ? byId.get(raw.target) : undefined;
    if (!source || !target) {
      issues.push({ code: "invalid_edge", message: "La conexión apunta a un nodo o puerto inexistente.", edgeId: raw.id });
      continue;
    }
    const edge = raw as unknown as AutomationWorkflowEdge;
    outgoing.set(source.id, [...(outgoing.get(source.id) ?? []), edge]);
    incoming.set(target.id, [...(incoming.get(target.id) ?? []), edge]);
    if (raw.targetPort !== "in" || !isValidSourcePort(source, raw.sourcePort)) {
      issues.push({ code: "invalid_edge", message: "La conexión apunta a un nodo o puerto inexistente.", edgeId: raw.id });
    }
  }

  for (const node of byId.values()) {
    const ins = incoming.get(node.id) ?? [];
    const outs = outgoing.get(node.id) ?? [];
    if (node.type === "trigger.event" && ins.length > 0) issues.push({ code: "invalid_edge", message: "El trigger no puede tener una conexión de entrada.", nodeId: node.id });
    if (node.type === "flow.end" && outs.length > 0) issues.push({ code: "invalid_edge", message: "El nodo de fin no puede tener conexiones de salida.", nodeId: node.id });
    if (ins.length > 1) issues.push({ code: "multiple_incoming", message: "Un nodo solo admite una conexión de entrada en v1.", nodeId: node.id });
    if (node.type === "condition.if") {
      for (const port of ["true", "false"] as const) {
        if (outs.filter((edge) => edge.sourcePort === port).length !== 1) {
          issues.push({ code: "missing_branch", message: `Conecta la salida ${port === "true" ? "Verdadero" : "Falso"}.`, nodeId: node.id });
        }
      }
    }
    if (node.type === "condition.switch") {
      for (const port of [...node.config.cases.map((item) => `case:${item.id}`), "default"]) {
        if (outs.filter((edge) => edge.sourcePort === port).length !== 1) {
          issues.push({ code: "missing_branch", message: `Conecta la salida ${port === "default" ? "Por defecto" : node.config.cases.find((item) => port === `case:${item.id}`)?.value ?? "del caso"}.`, nodeId: node.id });
        }
      }
    }
  }

  const contactActions = [...byId.values()].filter((node) => node.type === "contact.manage_tag" || node.type === "contact.update_field");
  if (contactActions.length) {
    const trigger = triggers[0];
    if (!trigger || !["contact.created", "contact.updated"].includes(trigger.config.eventType)) {
      for (const node of contactActions) issues.push({ code: "invalid_node", message: "Las acciones de contacto requieren un trigger de contacto.", nodeId: node.id });
    }
  }

  const conversationActions = [...byId.values()].filter((node) => node.type === "conversation.assign");
  if (conversationActions.length) {
    const trigger = triggers[0];
    if (!trigger || !["conversation.assigned", "conversation.status_changed"].includes(trigger.config.eventType)) {
      for (const node of conversationActions) issues.push({ code: "invalid_node", message: "La asignación requiere un trigger de conversación.", nodeId: node.id });
    }
  }
  const opportunityActions = [...byId.values()].filter((node) => node.type === "opportunity.assign");
  const trigger = triggers[0];
  if (opportunityActions.length && (!trigger || !["opportunity.created", "opportunity.stage_changed", "opportunity.assigned", "opportunity.archived", "opportunity.restored", "opportunity.next_action_changed"].includes(trigger.config.eventType))) {
    for (const node of opportunityActions) issues.push({ code: "invalid_node", message: "La asignación requiere un trigger de oportunidad.", nodeId: node.id });
  }
  const appointmentActions = [...byId.values()].filter((node) => node.type === "appointment.update_status");
  if (appointmentActions.length && (!trigger || !["appointment.created", "appointment.updated", "appointment.status_changed", "appointment.rescheduled"].includes(trigger.config.eventType))) {
    for (const node of appointmentActions) issues.push({ code: "invalid_node", message: "El cambio de estado requiere un trigger de cita.", nodeId: node.id });
  }

  if (triggers.length === 1 && byId.size > 0) {
    const reachable = walk(triggers[0]!.id, outgoing, new Set());
    for (const node of byId.values()) {
      if (!reachable.has(node.id)) issues.push({ code: "orphan_node", message: "El nodo no se alcanza desde el trigger.", nodeId: node.id });
      if (reachable.has(node.id) && node.type !== "flow.end" && (outgoing.get(node.id) ?? []).length === 0) {
        issues.push({ code: "orphan_node", message: "Esta ruta no termina en un nodo de fin.", nodeId: node.id });
      }
    }
    if (hasCycle(triggers[0]!.id, outgoing)) issues.push({ code: "cycle", message: "El workflow no puede contener ciclos en v1." });
  }
  return issues;
}

export function migrateAutomationWorkflowDefinition(value: unknown): AutomationWorkflowDefinition {
  if (!isRecord(value) || value.schemaVersion !== AUTOMATION_WORKFLOW_SCHEMA_VERSION) {
    throw new Error("La versión del workflow requiere una migración no disponible.");
  }
  const issues = validateAutomationWorkflowDefinition(value);
  if (issues.some((issue) => issue.code === "unsupported_version" || issue.code === "invalid_definition")) {
    throw new Error("El workflow no se puede leer con el esquema actual.");
  }
  return value as unknown as AutomationWorkflowDefinition;
}

function isNodeConfigValid(value: Record<string, unknown>): boolean {
  if (!isRecord(value.position) || !isRecord(value.config)) return false;
  if (value.type === "trigger.event") {
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["eventType"])
      && typeof value.config.eventType === "string" && (AUTOMATION_EVENT_TYPES as readonly string[]).includes(value.config.eventType);
  }
  if (value.type === "condition.if") {
    const config = value.config;
    return exactKeys(value, ["id", "type", "position", "config"]) &&
      (exactKeys(config, ["field", "operator"]) || exactKeys(config, ["field", "operator", "value"])) &&
      typeof config.field === "string" && CONDITION_FIELDS.includes(config.field as AutomationWorkflowConditionField) &&
      typeof config.operator === "string" && OPERATORS.includes(config.operator as AutomationWorkflowOperator) &&
      ((["is_empty", "is_not_empty"].includes(config.operator) && config.value === undefined) ||
        (!["is_empty", "is_not_empty"].includes(config.operator) && typeof config.value === "string" && config.value.length <= 200));
  }
  if (value.type === "condition.switch") {
    const config = value.config;
    if (!exactKeys(value, ["id", "type", "position", "config"]) || !exactKeys(config, ["field", "cases"])
      || typeof config.field !== "string" || !CONDITION_FIELDS.includes(config.field as AutomationWorkflowConditionField)
      || !Array.isArray(config.cases) || config.cases.length < 2 || config.cases.length > 5) return false;
    const caseValues = new Set<string>();
    return config.cases.every((item) => {
      if (!isRecord(item) || !exactKeys(item, ["id", "value"]) || typeof item.id !== "string" || !UUID.test(item.id)
        || typeof item.value !== "string" || !item.value.trim() || item.value.trim().length > 200) return false;
      const normalized = item.value.trim().toLocaleLowerCase("en-US");
      if (caseValues.has(normalized)) return false;
      caseValues.add(normalized);
      return true;
    });
  }
  if (value.type === "flow.end") {
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["outcome"])
      && (value.config.outcome === "complete" || value.config.outcome === "stop");
  }
  if (value.type === "flow.wait") {
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["durationSeconds"])
      && Number.isInteger(value.config.durationSeconds) && Number(value.config.durationSeconds) >= 1 && Number(value.config.durationSeconds) <= 31_536_000;
  }
  if (value.type === "opportunity.update_stage") {
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["stage"])
      && ["new", "working", "closing", "won", "lost"].includes(String(value.config.stage));
  }
  if (value.type === "opportunity.assign") {
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["assignedUserId"])
      && (value.config.assignedUserId === null || (typeof value.config.assignedUserId === "string" && UUID.test(value.config.assignedUserId)));
  }
  if (value.type === "appointment.update_status") {
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["status"])
      && ["scheduled", "confirmed", "cancelled", "completed", "no_show"].includes(String(value.config.status));
  }
  if (value.type === "contact.manage_tag") {
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["action", "tag"])
      && (value.config.action === "add" || value.config.action === "remove")
      && typeof value.config.tag === "string" && value.config.tag.trim().length > 0 && value.config.tag.trim().length <= 64;
  }
  if (value.type === "contact.update_field") {
    const field = value.config.field;
    const valueText = value.config.value;
    const maxLength = field === "displayName" ? 120 : field === "preferredLanguage" ? 16 : 0;
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["field", "value"])
      && maxLength > 0 && typeof valueText === "string" && valueText.trim().length > 0 && valueText.trim().length <= maxLength
      && (field !== "preferredLanguage" || /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(valueText.trim()));
  }
  if (value.type === "conversation.assign") {
    return exactKeys(value, ["id", "type", "position", "config"]) && exactKeys(value.config, ["assignedUserId"])
      && (value.config.assignedUserId === null || (typeof value.config.assignedUserId === "string" && UUID.test(value.config.assignedUserId)));
  }
  return false;
}

function isValidSourcePort(node: AutomationWorkflowNode, port: unknown): boolean {
  if (node.type === "condition.if") return port === "true" || port === "false";
  if (node.type === "condition.switch") return port === "default" || (typeof port === "string" && node.config.cases.some((item) => port === `case:${item.id}`));
  return node.type !== "flow.end" && port === "next";
}

function walk(id: string, outgoing: Map<string, AutomationWorkflowEdge[]>, visited: Set<string>): Set<string> {
  if (visited.has(id)) return visited;
  visited.add(id);
  for (const edge of outgoing.get(id) ?? []) walk(edge.target, outgoing, visited);
  return visited;
}

function hasCycle(start: string, outgoing: Map<string, AutomationWorkflowEdge[]>): boolean {
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const edge of outgoing.get(id) ?? []) if (visit(edge.target)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return visit(start);
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10000;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
