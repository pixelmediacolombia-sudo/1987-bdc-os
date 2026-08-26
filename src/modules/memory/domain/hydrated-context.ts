export type MessageDirection = "inbound" | "outbound";
export type MessageSenderType = "agent" | "client" | "staff";

export type TenantFeatureFlags = {
  sofiaEnabled: boolean;
  qualificationFlowEnabled: boolean;
  qualificationSignalEnabled: boolean;
};

export type PolicyPack = {
  version: string;
  downPayment: {
    min: number | null;
    max: number | null;
    currency: string;
  };
  quietHours: {
    enabled: boolean;
    start: string | null;
    end: string | null;
  };
  humanHandoff: {
    enabled: boolean;
    triggers: string[];
  };
  financialBoundaries?: {
    disclaimer?: {
      code: string;
      text: string;
    };
  };
  [key: string]: unknown;
};

export interface HydratedContext {
  tenant: {
    id: string;
    ghlLocationId?: string;
    timezone: string;
    policyVersion: string;
    status: string;
    flags: TenantFeatureFlags;
    policies: PolicyPack;
  };
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
  transcript: Array<{
    direction: MessageDirection;
    senderType: MessageSenderType;
    content: string;
    createdAt: Date;
  }>;
  activeFacts: Record<string, string>;
  objectivesLedger: Array<{
    objectiveType: string;
    asked: boolean;
    answered: boolean;
    skipped: boolean;
  }>;
}

export class HydrationNotFoundError extends Error {
  constructor(resource: "tenant" | "contact" | "conversation", id: string) {
    super(`Cannot hydrate ${resource} ${id}: record not found`);
    this.name = "HydrationNotFoundError";
  }
}
