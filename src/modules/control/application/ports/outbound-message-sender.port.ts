import type { OutboundMessageRegistryEntry } from "@/modules/control/application/ports/outbound-message-registry.port";

export type OutboundMessageRequest = Omit<OutboundMessageRegistryEntry, "providerMessageId"> & {
  providerMessageId?: string;
};

export type ProviderOutboundMessage = {
  providerMessageId: string;
};

export interface OutboundMessageProviderPort {
  send(input: OutboundMessageRequest): Promise<ProviderOutboundMessage>;
}
