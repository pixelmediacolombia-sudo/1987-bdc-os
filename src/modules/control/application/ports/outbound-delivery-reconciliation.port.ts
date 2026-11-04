export type ProviderDeliveryLookup = {
  result: "found" | "not_found" | "unknown";
  providerStatus?: string;
  error?: string;
};

export interface OutboundDeliveryReconciliationProviderPort {
  lookup(input: {
    tenantId: string;
    contactId: string;
    providerMessageId: string;
  }): Promise<ProviderDeliveryLookup>;
}
