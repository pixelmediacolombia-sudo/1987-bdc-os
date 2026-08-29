export type MetaCapiDealerKey =
  | "COUNTRY_CLUB"
  | "OFFLEASE"
  | "KOONS_CULPEPER"
  | "KOONS_FBURG_ES"
  | "ACTION"
  | "ARLINGTON"
  | "EASTERNS_ES";

export type MetaCapiTenantConfig = {
  key: MetaCapiDealerKey;
  datasetId: string;
  accessToken: string;
};

const DEALER_ENV_KEYS: MetaCapiDealerKey[] = [
  "COUNTRY_CLUB",
  "OFFLEASE",
  "KOONS_CULPEPER",
  "KOONS_FBURG_ES",
  "ACTION",
  "ARLINGTON",
  "EASTERNS_ES",
];

// These are routing identifiers, not secrets. Multiple locations intentionally
// point to one key when the master map assigns them to one Meta dataset.
const DEALER_LOCATION_IDS: Record<MetaCapiDealerKey, readonly string[]> = {
  COUNTRY_CLUB: ["k9DePpsNBu9qWT1C6pW0"],
  OFFLEASE: ["LiaoSID3nvAhad49ZpNJ", "MyxWNKacThim798E8KC6"],
  KOONS_CULPEPER: ["bTNJHpNZ8FaS1PUHkuUq"],
  KOONS_FBURG_ES: ["xuHo0opTO2g5edIuPJRl"],
  ACTION: ["ZxadcudjvBz7KFCB1od4"],
  ARLINGTON: ["9v8zH9Y5eLiiJwZTZDci"],
  EASTERNS_ES: ["MRHcOwdTqaN5cug3eSWW", "113zMWQlhKKBUu5wOYtR", "xN2LSSl62okzv9GnOJPU"],
};

const DEALER_ALIASES: Record<MetaCapiDealerKey, string[]> = {
  COUNTRY_CLUB: ["countryclub", "country club", "country_club"],
  OFFLEASE: ["offlease", "off lease", "off_lease"],
  KOONS_CULPEPER: ["koons culpeper", "koons_culpeper", "culpeper"],
  KOONS_FBURG_ES: ["koons fredericksburg", "koons_fredericksburg", "fredericksburg"],
  ACTION: ["action pre-owned", "action preowned", "action_preowned"],
  ARLINGTON: ["arlington woodbridge", "arlington_woodbridge", "woodbridge"],
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
  tenantDocument: string,
  dealers: MetaCapiTenantConfig[],
  ghlLocationId?: string,
): MetaCapiTenantConfig | undefined {
  const locationMatch = dealers.find((dealer) => DEALER_LOCATION_IDS[dealer.key].includes(ghlLocationId ?? ""));
  if (locationMatch) return locationMatch;

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

export function metaCapiDealerLocationIds(key: MetaCapiDealerKey): readonly string[] {
  return DEALER_LOCATION_IDS[key];
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}
