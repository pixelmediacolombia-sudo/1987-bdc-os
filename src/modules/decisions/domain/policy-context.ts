import type { PolicyPack } from "@/modules/memory/domain/hydrated-context";

export type PolicyContext = {
  tenant: {
    id: string;
    timezone: string;
    policyVersion: string;
    status: string;
    policies: PolicyPack;
  };
  contact: {
    id: string;
    ghlContactId: string;
    consentState: string;
  };
  lastInboundMessage?: string;
  activeFacts: Record<string, string>;
};
