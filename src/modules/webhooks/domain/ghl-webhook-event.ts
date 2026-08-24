export type JsonObject = Record<string, unknown>;

export type InboundMessage = {
  externalId: string;
  contactId: string;
  conversationId?: string;
  phone?: string;
  email?: string;
  ctwaClid?: string;
  ctwaSourceId?: string;
  ctwaCapturedAt?: string;
  channel: string;
  content: string;
  semanticHash: string;
};

export type HumanInterruptionTrigger = "staff_message" | "control_tag";

export type HumanInterruption = {
  trigger: HumanInterruptionTrigger;
  contactId: string;
  conversationId?: string;
  ownerId?: string;
  controlTag?: string;
  staffMessage?: InboundMessage;
};

export type GhlWebhookEvent = {
  externalId: string;
  eventType: string;
  locationId: string;
  signature: string;
  rawBody: Buffer;
  payload: JsonObject;
  contactId?: string;
  conversationId?: string;
  humanInterruption?: HumanInterruption;
  inboundMessage?: InboundMessage;
};

export class InvalidGhlWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGhlWebhookError";
  }
}

export class GhlTenantNotFoundError extends Error {
  constructor(locationId: string) {
    super(`No tenant configured for GHL location ${locationId}`);
    this.name = "GhlTenantNotFoundError";
  }
}
