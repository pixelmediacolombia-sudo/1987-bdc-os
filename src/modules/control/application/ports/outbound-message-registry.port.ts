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

export type OutboundDeliveryUncertainty = {
  tenantId: string;
  attemptId: string;
  contactId: string;
  providerMessageId: string;
  content: string;
  uncertaintyReason: string;
  detectedAt: Date;
  reconciliationAttempts: number;
  lastReconciliationError?: string;
};

export type OutboundDeliveryResolution = "confirmed" | "not_found" | "cancelled";

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
  markDeliveryUncertain?(input: {
    tenantId: string;
    attemptId: string;
    providerMessageId: string;
    reason: string;
  }): Promise<void>;
  listDeliveryUncertainties?(tenantId: string): Promise<OutboundDeliveryUncertainty[]>;
  recordDeliveryReconciliationAttempt?(input: {
    tenantId: string;
    attemptId: string;
    result: "found" | "not_found" | "unknown";
    providerStatus?: string;
    error?: string;
  }): Promise<void>;
  resolveDeliveryUncertainty?(input: {
    tenantId: string;
    attemptId: string;
    resolution: OutboundDeliveryResolution;
    reviewer: string;
    providerStatus?: string;
  }): Promise<void>;
  wasIssuedBy1987(input: {
    tenantId: string;
    contactId: string;
    semanticHash?: string;
    providerMessageId?: string;
    content?: string;
  }): Promise<boolean>;
}
