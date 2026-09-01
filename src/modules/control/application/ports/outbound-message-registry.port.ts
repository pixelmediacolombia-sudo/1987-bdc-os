export type OutboundMessageRegistryEntry = {
  tenantId: string;
  contactId: string;
  semanticHash: string;
  providerMessageId?: string;
  content: string;
};

export type OutboundMessageReservation = {
  attemptId: string;
  expiresAt: Date;
};

export interface OutboundMessageRegistryPort {
  register(entry: OutboundMessageRegistryEntry): Promise<OutboundMessageReservation>;
  attachProviderMessageId(input: {
    tenantId: string;
    attemptId: string;
    providerMessageId: string;
  }): Promise<void>;
  markFailed(input: {
    tenantId: string;
    attemptId: string;
  }): Promise<void>;
  wasIssuedBy1987(input: {
    tenantId: string;
    contactId: string;
    semanticHash?: string;
    providerMessageId?: string;
    content?: string;
  }): Promise<boolean>;
}
