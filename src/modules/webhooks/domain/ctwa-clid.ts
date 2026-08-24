import type { JsonObject } from "@/modules/webhooks/domain/ghl-webhook-event";

export type CtwaAttribution = {
  ctwaClid?: string;
  sourceId?: string;
};

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function valueAt(payload: JsonObject, path: string): unknown {
  let value: unknown = payload;
  for (const part of path.split(".")) value = asObject(value)?.[part];
  return value;
}

function stringAt(payload: JsonObject, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = valueAt(payload, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * GHL has used more than one nesting/name convention for WhatsApp referral
 * data. Keep the raw webhook as the source of truth and normalize only the
 * queryable contact attribution fields here.
 */
export function extractCtwaAttribution(payload: JsonObject): CtwaAttribution {
  const ctwaClid = stringAt(payload, [
    "ctwa_clid",
    "ctwaClid",
    "referral.ctwa_clid",
    "referral.ctwaClid",
    "message.referral.ctwa_clid",
    "message.referral.ctwaClid",
    "data.referral.ctwa_clid",
    "data.referral.ctwaClid",
    "data.message.referral.ctwa_clid",
    "data.message.referral.ctwaClid",
  ]);
  const sourceId = stringAt(payload, [
    "source_id",
    "sourceId",
    "referral.source_id",
    "referral.sourceId",
    "message.referral.source_id",
    "message.referral.sourceId",
    "data.referral.source_id",
    "data.referral.sourceId",
    "data.message.referral.source_id",
    "data.message.referral.sourceId",
  ]);

  return {
    ...(ctwaClid ? { ctwaClid } : {}),
    ...(sourceId ? { sourceId } : {}),
  };
}
