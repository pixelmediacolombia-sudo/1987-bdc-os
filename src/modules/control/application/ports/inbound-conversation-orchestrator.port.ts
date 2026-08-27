import type { InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";
import type { NextBestAction } from "@/modules/decisions/domain/next-best-action";
import type { SofiaMediaContext } from "@/modules/media/media";

export type BufferedInboundMessage = InboundMessage & {
  receivedAt: string;
};

export type ConsolidatedInboundConversation = {
  tenantId: string;
  contactId: string;
  messages: BufferedInboundMessage[];
  consolidatedText: string;
  mediaContext?: SofiaMediaContext;
  objectiveType?: string;
  requestedAction?: NextBestAction;
  outboundCandidate?: {
    content: string;
    semanticHash: string;
    channel?: "SMS" | "Email" | "WhatsApp" | "IG" | "FB" | "Custom" | "Live_Chat" | "InternalComment";
  };
};

export interface InboundConversationOrchestratorPort {
  process(input: ConsolidatedInboundConversation): Promise<void>;
}
