export type MetaMessagingChannel = "messenger" | "instagram" | "whatsapp";

export type MetaGraphMessageInput = {
  channel: MetaMessagingChannel;
  senderId: string;
  recipientId: string;
  accessToken: string;
  text: string;
};

export type MetaGraphMessageResult = { messageId: string };

export class MetaGraphApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MetaGraphApiError";
  }
}

export class MetaGraphApiClient {
  constructor(
    private readonly baseUrl = "https://graph.facebook.com",
    private readonly apiVersion = "v27.0",
    private readonly request: typeof fetch = fetch,
  ) {}

  async sendText(input: MetaGraphMessageInput): Promise<MetaGraphMessageResult> {
    if (!input.senderId.trim() || !input.recipientId.trim() || !input.accessToken.trim() || !input.text.trim()) {
      throw new MetaGraphApiError("Meta message is missing required delivery fields", 400);
    }

    const url = new URL(`/${this.apiVersion}/${encodeURIComponent(input.senderId)}/messages`, this.baseUrl);
    url.searchParams.set("access_token", input.accessToken);
    const body = input.channel === "whatsapp"
      ? { messaging_product: "whatsapp", recipient: { id: input.recipientId }, type: "text", text: { body: input.text } }
      : { recipient: { id: input.recipientId }, messaging_type: "RESPONSE", message: { text: input.text } };

    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new MetaGraphApiError("Meta Graph API request failed before a response was received");
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = payload && typeof payload === "object" ? (payload as { error?: { message?: unknown } }).error : undefined;
      const detail = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new MetaGraphApiError(`Meta Graph API rejected message: ${detail.replaceAll(input.accessToken, "[REDACTED]")}`, response.status);
    }

    const messageId = payload && typeof payload === "object"
      ? (payload as { message_id?: unknown; messages?: Array<{ id?: unknown }> }).message_id
        ?? (payload as { messages?: Array<{ id?: unknown }> }).messages?.[0]?.id
      : undefined;
    if (typeof messageId !== "string" || !messageId.trim()) {
      throw new MetaGraphApiError("Meta Graph API response did not include a message id", 502);
    }
    return { messageId };
  }
}
