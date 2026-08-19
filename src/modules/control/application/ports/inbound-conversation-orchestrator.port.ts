import type { InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";

export type BufferedInboundMessage = InboundMessage & {
  receivedAt: string;
};

export type ConsolidatedInboundConversation = {
  contactId: string;
  messages: BufferedInboundMessage[];
  consolidatedText: string;
};

export interface InboundConversationOrchestratorPort {
  process(input: ConsolidatedInboundConversation): Promise<void>;
}
