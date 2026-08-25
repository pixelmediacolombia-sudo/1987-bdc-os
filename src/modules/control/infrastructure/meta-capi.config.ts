export type MetaCapiDealerKey = "COUNTRY_CLUB" | "KOONS_CULPEPER" | "EASTERNS_ES";

export type MetaCapiTenantConfig = {
  key: MetaCapiDealerKey;
  datasetId: string;
  accessToken: string;
};

const DEALER_ENV_KEYS: MetaCapiDealerKey[] = ["COUNTRY_CLUB", "KOONS_CULPEPER", "EASTERNS_ES"];

const DEALER_ALIASES: Record<MetaCapiDealerKey, string[]> = {
  COUNTRY_CLUB: ["countryclub", "country club", "country_club"],
  KOONS_CULPEPER: ["koons", "culpeper", "koons_culpeper"],
  EASTERNS_ES: ["easterns", "easterns_es", "easterns es"],
};

export function loadMetaCapiEnvConfig(env: NodeJS.ProcessEnv = process.env): {
  eventName: string;
  dealers: MetaCapiTenantConfig[];
} {
  const dealers: MetaCapiTenantConfig[] = [];
  for (const key of DEALER_ENV_KEYS) {
    const datasetId = env[`META_CAPI_DATASET_${key}`]?.trim();
    const accessToken = env[`META_CAPI_TOKEN_${key}`]?.trim();
    if (!datasetId && !accessToken) continue;
    if (!datasetId || !accessToken) {
      throw new Error(`META_CAPI_DATASET_${key} and META_CAPI_TOKEN_${key} must be configured together`);
    }
    dealers.push({ key, datasetId, accessToken });
  }

  return {
    eventName: env.META_CAPI_EVENT_NAME?.trim() || "Lead_Calificado",
    dealers,
  };
}

export function findMetaCapiEnvConfig(
  tenantDocument: string,
  dealers: MetaCapiTenantConfig[],
): MetaCapiTenantConfig | undefined {
  const normalizedDocument = normalizeSearchText(tenantDocument);
  return dealers.find((dealer) => DEALER_ALIASES[dealer.key].some((alias) => normalizedDocument.includes(normalizeSearchText(alias))));
}

export function identifyMetaCapiDealerKey(tenantDocument: string): MetaCapiDealerKey | undefined {
  return (Object.keys(DEALER_ALIASES) as MetaCapiDealerKey[])
    .find((key) => DEALER_ALIASES[key].some((alias) => normalizeSearchText(tenantDocument).includes(normalizeSearchText(alias))));
}

export function metaCapiDealerAliases(key: MetaCapiDealerKey): readonly string[] {
  return DEALER_ALIASES[key];
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}
