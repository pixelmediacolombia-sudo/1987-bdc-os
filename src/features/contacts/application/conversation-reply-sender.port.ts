export type ConversationReplyChannel = "FB" | "IG" | "WhatsApp";

export interface ConversationReplySender {
  send(input: {
    tenantId: string;
    contactId: string;
    content: string;
    channel: ConversationReplyChannel;
    clientMessageId: string;
  }): Promise<{ providerMessageId: string }>;
}
