import { createHash } from "node:crypto";
import type { SofiaLeadLevel } from "@/modules/decisions/domain/sofia-conversation";

export type MetaCapiPayload = {
  data: Array<{
    event_name: string;
    event_time: number;
    action_source: "business_messaging";
    event_id: string;
    messaging_channel: "whatsapp";
    user_data: Record<string, string>;
    custom_data: {
      dealer: string;
      objectives_answered: number;
      lead_source: "whatsapp_ctwa";
      lead_level?: SofiaLeadLevel;
      push_accepted?: boolean;
      has_trade_in?: boolean;
    };
  }>;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashEmail(email?: string): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized ? sha256(normalized) : undefined;
}

export function hashPhone(phone?: string): string | undefined {
  const digits = phone?.replace(/\D/g, "") ?? "";
  if (!digits) return undefined;
  const e164WithoutPlus = digits.length === 10 ? `1${digits}` : digits;
  return sha256(e164WithoutPlus);
}

export function buildMetaCapiPayload(input: {
  eventName: string;
  eventId: string;
  eventTime: Date;
  dealer: string;
  contactId: string;
  phone?: string;
  email?: string;
  ctwaClid?: string;
  objectivesAnswered: number;
  leadLevel?: SofiaLeadLevel;
  pushAccepted?: boolean;
  hasTradeIn?: boolean;
}): MetaCapiPayload {
  const userData: Record<string, string> = {
    external_id: sha256(input.contactId),
  };
  const phoneHash = hashPhone(input.phone);
  const emailHash = hashEmail(input.email);
  if (phoneHash) userData.ph = phoneHash;
  if (emailHash) userData.em = emailHash;
  if (input.ctwaClid?.trim()) userData.ctwa_clid = input.ctwaClid.trim();

  return {
    data: [{
      event_name: input.eventName,
      event_time: Math.floor(input.eventTime.getTime() / 1000),
      action_source: "business_messaging",
      event_id: input.eventId,
      messaging_channel: "whatsapp",
      user_data: userData,
      custom_data: {
        dealer: input.dealer,
        objectives_answered: input.objectivesAnswered,
        lead_source: "whatsapp_ctwa",
        ...(input.leadLevel ? { lead_level: input.leadLevel } : {}),
        ...(input.pushAccepted === undefined ? {} : { push_accepted: input.pushAccepted }),
        ...(input.hasTradeIn === undefined ? {} : { has_trade_in: input.hasTradeIn }),
      },
    }],
  };
}

export function retryDelayMs(attempt: number): number {
  return [60_000, 300_000, 900_000, 3_600_000, 21_600_000][Math.max(0, Math.min(attempt - 1, 4))] ?? 21_600_000;
}
