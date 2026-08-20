export type OutboundMessageRegistryEntry = {
  tenantId: string;
  contactId: string;
  semanticHash: string;
  providerMessageId?: string;
  content: string;
};

export interface OutboundMessageRegistryPort {
  register(entry: OutboundMessageRegistryEntry): Promise<void>;
  attachProviderMessageId(input: {
    tenantId: string;
    contactId: string;
    semanticHash: string;
    providerMessageId: string;
  }): Promise<void>;
  wasIssuedBy1987(input: {
    tenantId: string;
    contactId: string;
    semanticHash: string;
    providerMessageId?: string;
  }): Promise<boolean>;
}
