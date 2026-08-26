import type { MessageDirection, MessageSenderType, TenantFeatureFlags } from "@/modules/memory/domain/hydrated-context";

export type TenantProfile = {
  id: string;
  timezone: string;
  policyVersion: string;
  status: string;
  flags: TenantFeatureFlags;
};

export type ContactConversation = {
  contact: {
    id: string;
    ghlContactId: string;
    preferredLanguage: string;
    consentState: string;
  };
  conversation: {
    id: string;
    channel: string;
    state: string;
  };
};

export type RecentTranscriptMessage = {
  direction: MessageDirection;
  senderType: MessageSenderType;
  content: string;
  createdAt: Date;
};

export type ActiveFact = { key: string; value: string };

export type ObjectiveLedgerEntry = {
  objectiveType: string;
  asked: boolean;
  answered: boolean;
  skipped: boolean;
};

export interface HydrationRepositoryPort {
  loadTenant(tenantId: string): Promise<TenantProfile>;
  loadContactConversation(tenantId: string, ghlContactId: string): Promise<ContactConversation>;
  loadRecentTranscript(tenantId: string, conversationId: string, limit: number): Promise<RecentTranscriptMessage[]>;
  loadActiveFacts(tenantId: string, contactId: string): Promise<ActiveFact[]>;
  loadObjectives(tenantId: string, contactId: string): Promise<ObjectiveLedgerEntry[]>;
}
