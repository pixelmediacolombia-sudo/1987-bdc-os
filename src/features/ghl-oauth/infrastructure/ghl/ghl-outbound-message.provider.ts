import type { GhlApiClient } from "@/features/ghl-oauth/infrastructure/ghl/ghl-api.client";
import type {
  OutboundMessageProviderPort,
  OutboundMessageRequest,
  ProviderOutboundMessage,
} from "@/modules/control/application/ports/outbound-message-sender.port";

type GhlSendMessageResponse = {
  messageId?: unknown;
  messageIds?: unknown;
};

/** GHL transport invoked only after the application sender passes its veto. */
export class GhlOutboundMessageProvider implements OutboundMessageProviderPort {
  constructor(
    private readonly apiClient: GhlApiClient,
    private readonly defaultChannel: NonNullable<OutboundMessageRequest["channel"]> = "SMS",
  ) {}

  async send(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    const response = await this.apiClient.request<GhlSendMessageResponse>(input.tenantId, {
      method: "POST",
      url: "https://services.leadconnectorhq.com/conversations/messages",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "v3",
      },
      data: {
        type: input.channel ?? this.defaultChannel,
        contactId: input.contactId,
        message: input.content,
        status: "pending",
      },
    });

    const messageId = typeof response.data.messageId === "string"
      ? response.data.messageId
      : Array.isArray(response.data.messageIds) && typeof response.data.messageIds[0] === "string"
        ? response.data.messageIds[0]
        : undefined;
    if (!messageId?.trim()) throw new Error("GHL outbound response did not include messageId");
    return { providerMessageId: messageId };
  }
}
