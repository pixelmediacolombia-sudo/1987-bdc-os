import type { MetaMessagingConnectionPort } from "@/features/meta/application/meta-messaging-connection.port";
import { accessTokenForChannel, senderIdForChannel } from "@/features/meta/application/meta-messaging-connection.port";
import { MetaGraphApiClient, type MetaMessagingChannel } from "@/features/meta/infrastructure/meta-graph-api.client";
import type {
  OutboundMessageProviderPort,
  OutboundMessageRequest,
  ProviderOutboundMessage,
} from "@/modules/control/application/ports/outbound-message-sender.port";
import type { OutboundDeliveryReconciliationProviderPort } from "@/modules/control/application/ports/outbound-delivery-reconciliation.port";

export class MetaOutboundMessageProvider implements OutboundMessageProviderPort, OutboundDeliveryReconciliationProviderPort {
  constructor(
    private readonly connections: MetaMessagingConnectionPort,
    private readonly graph: MetaGraphApiClient,
  ) {}

  async send(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    const channel: MetaMessagingChannel | undefined = input.channel === "FB"
      ? "messenger"
      : input.channel === "IG" ? "instagram"
        : input.channel === "WhatsApp" ? "whatsapp" : undefined;
    if (!channel) throw new Error(`Meta messaging does not support channel ${input.channel ?? "unknown"}`);

    const connection = await this.connections.getForTenant(input.tenantId);
    if (!connection) throw new Error("Meta messaging is not connected for this dealer");
    const senderId = senderIdForChannel(channel, connection);
    if (!senderId) throw new Error(`Meta ${channel} sender is not configured for this dealer`);
    const accessToken = accessTokenForChannel(channel, connection);
    if (!accessToken) throw new Error(`Meta ${channel} credentials are not configured for this dealer`);

    const result = await this.graph.sendText({
      channel,
      senderId,
      recipientId: input.contactId,
      accessToken,
      text: input.content,
    });
    return { providerMessageId: result.messageId };
  }

  async lookup(): Promise<{ result: "unknown"; error: string }> {
    // Graph API message receipts arrive as webhook events; never retry an
    // ambiguous send based on an unsupported message-id lookup.
    return { result: "unknown", error: "Meta message delivery is confirmed by webhook receipts" };
  }
}
