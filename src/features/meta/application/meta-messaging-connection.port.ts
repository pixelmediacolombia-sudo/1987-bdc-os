import type { MetaMessagingChannel } from "@/features/meta/infrastructure/meta-graph-api.client";

export type MetaMessagingConnection = {
  pageAccessToken?: string;
  instagramAccessToken?: string;
  whatsappAccessToken?: string;
  pageId?: string;
  instagramBusinessId?: string;
  whatsappPhoneNumberId?: string;
};

export interface MetaMessagingConnectionPort {
  getForTenant(tenantId: string): Promise<MetaMessagingConnection | undefined>;
}

export function senderIdForChannel(
  channel: MetaMessagingChannel,
  connection: MetaMessagingConnection,
): string | undefined {
  if (channel === "messenger") return connection.pageId;
  if (channel === "instagram") return connection.instagramBusinessId;
  return connection.whatsappPhoneNumberId;
}

export function accessTokenForChannel(
  channel: MetaMessagingChannel,
  connection: MetaMessagingConnection,
): string | undefined {
  if (channel === "messenger") return connection.pageAccessToken;
  if (channel === "instagram") return connection.instagramAccessToken ?? connection.pageAccessToken;
  return connection.whatsappAccessToken;
}
