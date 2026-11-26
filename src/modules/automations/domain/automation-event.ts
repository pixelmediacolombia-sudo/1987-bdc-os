export const AUTOMATION_EVENT_SCHEMA_VERSION = 1 as const;

export const AUTOMATION_EVENT_TYPES = [
  "contact.created",
  "contact.updated",
  "message.received",
  "message.sent",
  "conversation.assigned",
  "conversation.status_changed",
  "opportunity.created",
  "opportunity.stage_changed",
  "opportunity.assigned",
  "opportunity.archived",
  "opportunity.restored",
  "opportunity.next_action_changed",
  "appointment.created",
  "appointment.updated",
  "appointment.status_changed",
  "appointment.rescheduled",
] as const;

export type AutomationEventType = (typeof AUTOMATION_EVENT_TYPES)[number];
export type AutomationEntityType = "contact" | "message" | "conversation" | "opportunity" | "appointment";
export type AutomationEventOrigin = "crm" | "meta_webhook" | "scheduler" | "system";
export type AutomationActorType = "user" | "contact" | "provider" | "system";

export type AutomationEventPayloads = {
  "contact.created": { source: "manual" | "inbound" | "meta_webhook" };
  "contact.updated": { changedFields: string[] };
  "message.received": { conversationId: string; contactId: string; channel: string; senderType: "client" };
  "message.sent": { conversationId: string; contactId: string; channel: string; senderType: "staff" | "agent" | "system"; deliveryStatus: string };
  "conversation.assigned": { contactId: string; previousAssigneeId: string | null; assigneeId: string | null };
  "conversation.status_changed": { contactId: string; previousStatus: string; status: string };
  "opportunity.created": { contactId?: string; stage: string };
  "opportunity.stage_changed": { contactId?: string; previousStage: string; stage: string };
  "opportunity.assigned": { contactId?: string; previousAssigneeId: string | null; assigneeId: string | null };
  "opportunity.archived": { contactId?: string };
  "opportunity.restored": { contactId?: string };
  "opportunity.next_action_changed": { contactId?: string; nextActionAt: string | null };
  "appointment.created": { contactId?: string; opportunityId?: string; startsAt: string; endsAt: string; status: string };
  "appointment.updated": { contactId?: string; opportunityId?: string; startsAt: string; endsAt: string; status: string };
  "appointment.status_changed": { contactId?: string; previousStatus: string; status: string };
  "appointment.rescheduled": { contactId?: string; previousStartsAt: string; startsAt: string; endsAt: string };
};

const EVENT_DEFINITIONS = {
  "contact.created": { entity: "contact", required: ["source"], optional: [] },
  "contact.updated": { entity: "contact", required: ["changedFields"], optional: [] },
  "message.received": { entity: "message", required: ["conversationId", "contactId", "channel", "senderType"], optional: [] },
  "message.sent": { entity: "message", required: ["conversationId", "contactId", "channel", "senderType", "deliveryStatus"], optional: [] },
  "conversation.assigned": { entity: "conversation", required: ["contactId", "previousAssigneeId", "assigneeId"], optional: [] },
  "conversation.status_changed": { entity: "conversation", required: ["contactId", "previousStatus", "status"], optional: [] },
  "opportunity.created": { entity: "opportunity", required: ["stage"], optional: ["contactId"] },
  "opportunity.stage_changed": { entity: "opportunity", required: ["previousStage", "stage"], optional: ["contactId"] },
  "opportunity.assigned": { entity: "opportunity", required: ["previousAssigneeId", "assigneeId"], optional: ["contactId"] },
  "opportunity.archived": { entity: "opportunity", required: [], optional: ["contactId"] },
  "opportunity.restored": { entity: "opportunity", required: [], optional: ["contactId"] },
  "opportunity.next_action_changed": { entity: "opportunity", required: ["nextActionAt"], optional: ["contactId"] },
  "appointment.created": { entity: "appointment", required: ["startsAt", "endsAt", "status"], optional: ["contactId", "opportunityId"] },
  "appointment.updated": { entity: "appointment", required: ["startsAt", "endsAt", "status"], optional: ["contactId", "opportunityId"] },
  "appointment.status_changed": { entity: "appointment", required: ["previousStatus", "status"], optional: ["contactId"] },
  "appointment.rescheduled": { entity: "appointment", required: ["previousStartsAt", "startsAt", "endsAt"], optional: ["contactId"] },
} as const satisfies Record<AutomationEventType, { entity: AutomationEntityType; required: readonly string[]; optional: readonly string[] }>;

export type AutomationEventFor<T extends AutomationEventType> = {
  schemaVersion: typeof AUTOMATION_EVENT_SCHEMA_VERSION;
  eventId: string;
  tenantId: string;
  type: T;
  occurredAt: string;
  origin: AutomationEventOrigin;
  actor: { type: AutomationActorType; id?: string };
  entity: { type: (typeof EVENT_DEFINITIONS)[T]["entity"]; id: string };
  payload: AutomationEventPayloads[T];
};

export type AutomationEvent = {
  [T in AutomationEventType]: AutomationEventFor<T>;
}[AutomationEventType];

export class InvalidAutomationEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAutomationEventError";
  }
}

/**
 * Validates and narrows a versioned event before it reaches an automation
 * executor. Event payloads deliberately exclude message text, credentials,
 * arbitrary CRM objects, and caller-selected tenant context.
 */
export function parseAutomationEvent(value: unknown): AutomationEvent {
  if (!isRecord(value)) throw new InvalidAutomationEventError("Event must be an object");
  assertExactKeys(value, ["schemaVersion", "eventId", "tenantId", "type", "occurredAt", "origin", "actor", "entity", "payload"], "event");

  if (value.schemaVersion !== AUTOMATION_EVENT_SCHEMA_VERSION) throw new InvalidAutomationEventError("Unsupported event schema version");
  if (!isUuid(value.eventId) || !isUuid(value.tenantId)) throw new InvalidAutomationEventError("Event and tenant IDs must be UUIDs");
  if (typeof value.type !== "string" || !Object.hasOwn(EVENT_DEFINITIONS, value.type)) throw new InvalidAutomationEventError("Unsupported event type");
  if (!isIsoDateTime(value.occurredAt)) throw new InvalidAutomationEventError("occurredAt must be an ISO date-time");
  if (!["crm", "meta_webhook", "scheduler", "system"].includes(String(value.origin))) throw new InvalidAutomationEventError("Unsupported event origin");

  const type = value.type as AutomationEventType;
  const definition = EVENT_DEFINITIONS[type];
  if (!isRecord(value.actor)) throw new InvalidAutomationEventError("actor must be an object");
  assertExactKeys(value.actor, ["type", "id"], "actor");
  if (!["user", "contact", "provider", "system"].includes(String(value.actor.type))) throw new InvalidAutomationEventError("Unsupported actor type");
  if (value.actor.id !== undefined && !isBoundedString(value.actor.id, 160)) throw new InvalidAutomationEventError("actor.id must be a bounded string");

  if (!isRecord(value.entity)) throw new InvalidAutomationEventError("entity must be an object");
  assertExactKeys(value.entity, ["type", "id"], "entity");
  if (value.entity.type !== definition.entity || !isUuid(value.entity.id)) throw new InvalidAutomationEventError("Entity type or ID does not match the event");

  if (!isRecord(value.payload)) throw new InvalidAutomationEventError("payload must be an object");
  const allowedPayloadKeys = [...definition.required, ...definition.optional];
  assertExactKeys(value.payload, allowedPayloadKeys, "payload");
  for (const key of definition.required) {
    if (!Object.hasOwn(value.payload, key)) throw new InvalidAutomationEventError("payload." + key + " is required");
  }
  for (const [key, field] of Object.entries(value.payload)) assertPayloadField(key, field);

  return value as AutomationEvent;
}

function assertPayloadField(key: string, value: unknown): void {
  if (key === "changedFields") {
    if (!Array.isArray(value) || value.length > 25 || value.some((field) => typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(field))) {
      throw new InvalidAutomationEventError("payload.changedFields must contain at most 25 field names");
    }
    return;
  }
  if (value === null && ["previousAssigneeId", "assigneeId", "nextActionAt"].includes(key)) return;
  if (typeof value !== "string" || !value.trim() || value.length > 160) {
    throw new InvalidAutomationEventError("payload." + key + " must be a bounded string");
  }
  if (key.endsWith("Id") && !isUuid(value)) throw new InvalidAutomationEventError("payload." + key + " must be a UUID");
  if (["startsAt", "endsAt", "previousStartsAt", "nextActionAt"].includes(key) && !isIsoDateTime(value)) {
    throw new InvalidAutomationEventError("payload." + key + " must be an ISO date-time");
  }
  if (key === "source" && !["manual", "inbound", "meta_webhook"].includes(value)) throw new InvalidAutomationEventError("Unsupported contact source");
  if (key === "senderType" && !["client", "staff", "agent", "system"].includes(value)) throw new InvalidAutomationEventError("Unsupported message sender type");
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new InvalidAutomationEventError(label + " contains unsupported field " + unexpected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
