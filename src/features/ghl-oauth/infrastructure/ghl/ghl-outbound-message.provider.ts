import type { GhlApiClient } from "@/features/ghl-oauth/infrastructure/ghl/ghl-api.client";
import type {
  OutboundMessageProviderPort,
  OutboundMessageRequest,
  ProviderOutboundMessage,
} from "@/modules/control/application/ports/outbound-message-sender.port";
import type { OutboundDeliveryReconciliationProviderPort } from "@/modules/control/application/ports/outbound-delivery-reconciliation.port";
import axios from "axios";

type GhlSendMessageResponse = {
  messageId?: unknown;
  messageIds?: unknown;
};

/** GHL transport invoked only after the application sender passes its veto. */
type GhlMessageLookupResponse = {
  id?: unknown;
  contactId?: unknown;
  status?: unknown;
};

export class GhlOutboundMessageProvider
  implements OutboundMessageProviderPort, OutboundDeliveryReconciliationProviderPort {
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

  async lookup(input: {
    tenantId: string;
    contactId: string;
    providerMessageId: string;
  }) {
    try {
      const response = await this.apiClient.request<GhlMessageLookupResponse>(input.tenantId, {
        method: "GET",
        url: `https://services.leadconnectorhq.com/conversations/messages/${encodeURIComponent(input.providerMessageId)}`,
        headers: { Accept: "application/json", Version: "2023-02-21" },
      });
      const contactId = typeof response.data.contactId === "string" ? response.data.contactId : undefined;
      if (contactId && contactId !== input.contactId) {
        return { result: "unknown" as const, error: "Provider message belongs to another contact" };
      }
      return {
        result: "found" as const,
        ...(typeof response.data.status === "string" ? { providerStatus: response.data.status } : {}),
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return { result: "not_found" as const, providerStatus: "404" };
      }
      return {
        result: "unknown" as const,
        error: error instanceof Error ? error.message : "GHL message lookup failed",
      };
    }
  }
}
