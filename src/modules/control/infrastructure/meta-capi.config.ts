export type MetaCapiTenantConfig = {
  tenantId: string;
  datasetId: string;
  accessToken: string;
};

export function loadMetaCapiEnvConfig(env: NodeJS.ProcessEnv = process.env): {
  eventName: string;
  dealers: MetaCapiTenantConfig[];
} {
  let parsed: unknown = {};
  if (env.META_CAPI_DEALERS_JSON?.trim()) {
    try { parsed = JSON.parse(env.META_CAPI_DEALERS_JSON); }
    catch { throw new Error("META_CAPI_DEALERS_JSON must be valid JSON"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("META_CAPI_DEALERS_JSON must be an object keyed by tenant ID");
  }
  const dealers = Object.entries(parsed as Record<string, unknown>).map(([tenantId, raw]) => {
    const pair = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const datasetId = typeof pair.datasetId === "string" ? pair.datasetId.trim() : "";
    const accessToken = typeof pair.accessToken === "string" ? pair.accessToken.trim() : "";
    if (!tenantId.trim() || !datasetId || !accessToken) {
      throw new Error(`META_CAPI_DEALERS_JSON entry ${tenantId || "<empty>"} must include datasetId and accessToken`);
    }
    return { tenantId: tenantId.trim(), datasetId, accessToken };
  });

  return {
    eventName: normalizeMetaEventName(env.META_CAPI_EVENT_NAME?.trim()),
    dealers,
  };
}

function normalizeMetaEventName(value?: string): string {
  // Meta rejects this legacy custom name for business_messaging events.
  if (!value || value === "Lead_Calificado") return "LeadSubmitted";
  return value;
}

export function findMetaCapiEnvConfig(
  tenantId: string,
  dealers: MetaCapiTenantConfig[],
): MetaCapiTenantConfig | undefined {
  return dealers.find((dealer) => dealer.tenantId === tenantId);
}
