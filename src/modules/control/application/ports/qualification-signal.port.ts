import type { PoolClient } from "pg";

export type QualificationCompletion = {
  tenantId: string;
  ghlContactId: string;
  ledgerEntryId: string;
};

export interface QualificationCompletionPort {
  enqueueWithinTransaction(client: PoolClient, input: QualificationCompletion): Promise<void>;
}

export type CapiDeliveryEvent = {
  id: string;
  dealerId: string;
  eventId: string;
  eventName: string;
  payloadSent: Record<string, unknown>;
  datasetId?: string;
  accessToken?: string;
  encryptedAccessToken?: string;
  testEventCode?: string;
};

export type GhlTagDeliveryEvent = {
  id: string;
  dealerId: string;
  ghlContactId: string;
  ledgerEntryId: string;
};

export interface QualificationSignalRepository {
  listDealerIds(): Promise<string[]>;
  claimNextCapiEvent(dealerId: string): Promise<CapiDeliveryEvent | undefined>;
  markCapiSent(eventId: string, dealerId: string, fbtraceId?: string): Promise<void>;
  markCapiFailure(input: {
    dealerId: string;
    eventId: string;
    error: string;
    retryable: boolean;
    rateLimited?: boolean;
  }): Promise<void>;
  claimNextGhlTagEvent(dealerId: string): Promise<GhlTagDeliveryEvent | undefined>;
  markGhlTagSent(eventId: string, dealerId: string): Promise<void>;
  markGhlTagFailure(input: {
    dealerId: string;
    eventId: string;
    error: string;
    retryable: boolean;
    rateLimited?: boolean;
  }): Promise<void>;
}
