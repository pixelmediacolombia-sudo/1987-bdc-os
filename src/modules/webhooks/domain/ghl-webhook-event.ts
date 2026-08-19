export type JsonObject = Record<string, unknown>;

export type InboundMessage = {
  externalId: string;
  contactId: string;
  conversationId?: string;
  phone?: string;
  email?: string;
  channel: string;
  content: string;
  semanticHash: string;
};

export type GhlWebhookEvent = {
  externalId: string;
  eventType: string;
  locationId: string;
  signature: string;
  rawBody: Buffer;
  payload: JsonObject;
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
