import "dotenv/config";
import { loadMetaCapiEnvConfig, type MetaCapiTenantConfig } from "@/modules/control/infrastructure/meta-capi.config";

export type AppConfig = {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  pgSsl: boolean;
  redisUrl: string;
  burstBufferSeconds: number;
  burstBufferControlTtlSeconds: number;
  contactMutexTtlMs: number;
  qualificationFlowEnabled: boolean;
  qualificationSignalEnabled: boolean;
  qualificationSignalPollMs: number;
  metaCapiEventName: string;
  metaCapiDealers: MetaCapiTenantConfig[];
  sofiaEnabled: boolean;
  sofiaDealerName: string;
  mediaUnderstandingEnabled: boolean;
  whisperCliPath?: string;
  whisperModelPath?: string;
  tesseractCliPath?: string;
  ghlClientId: string;
  ghlClientSecret: string;
  ghlAppVersionId: string;
  ghlRedirectUri: string;
  ghlAuthorizationUrl: string;
  ghlTokenUrl: string;
  ghlScopes: string[];
  encryptionSecret: string;
  oauthStateSecret: string;
  policyDiagnosticToken?: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes"].includes(raw);
}

export function loadAppConfig(): AppConfig {
  const scopes = required("GHL_SCOPES").split(/[\s,]+/).filter(Boolean);
  const encryptionSecret = required("ENCRYPTION_SECRET");
  const oauthStateSecret = required("OAUTH_STATE_SECRET");
  const metaCapi = loadMetaCapiEnvConfig();

  if (Buffer.byteLength(encryptionSecret, "utf8") < 32) {
    throw new Error("ENCRYPTION_SECRET must contain at least 32 UTF-8 bytes");
  }
  if (Buffer.byteLength(oauthStateSecret, "utf8") < 32) {
    throw new Error("OAUTH_STATE_SECRET must contain at least 32 UTF-8 bytes");
  }

  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    databaseUrl: required("DATABASE_URL"),
    pgSsl: booleanEnv("PGSSL", false),
    redisUrl: required("REDIS_URL"),
    burstBufferSeconds: positiveNumberEnv("BURST_BUFFER_SECONDS", 15),
    burstBufferControlTtlSeconds: positiveNumberEnv("BURST_BUFFER_CONTROL_TTL_SECONDS", 90),
    contactMutexTtlMs: positiveNumberEnv("CONTACT_MUTEX_TTL_SECONDS", 30) * 1000,
    qualificationFlowEnabled: booleanEnv("QUALIFICATION_FLOW_ENABLED", false),
    qualificationSignalEnabled: booleanEnv("QUALIFICATION_SIGNAL_ENABLED", false),
    qualificationSignalPollMs: positiveNumberEnv("QUALIFICATION_SIGNAL_POLL_MS", 5000),
    metaCapiEventName: metaCapi.eventName,
    metaCapiDealers: metaCapi.dealers,
    sofiaEnabled: booleanEnv("SOFIA_ENABLED", false),
    sofiaDealerName: process.env.SOFIA_DEALER_NAME?.trim() || "el dealer",
    mediaUnderstandingEnabled: booleanEnv("MEDIA_UNDERSTANDING_ENABLED", false),
    whisperCliPath: process.env.WHISPER_CLI_PATH?.trim() || undefined,
    whisperModelPath: process.env.WHISPER_MODEL_PATH?.trim() || undefined,
    tesseractCliPath: process.env.TESSERACT_CLI_PATH?.trim() || undefined,
    ghlClientId: required("GHL_CLIENT_ID"),
    ghlClientSecret: required("GHL_CLIENT_SECRET"),
    ghlAppVersionId: required("GHL_APP_VERSION_ID"),
    ghlRedirectUri: required("GHL_REDIRECT_URI"),
    ghlAuthorizationUrl:
      process.env.GHL_AUTHORIZATION_URL?.trim() ||
      "https://marketplace.gohighlevel.com/oauth/chooselocation",
    ghlTokenUrl:
      process.env.GHL_TOKEN_URL?.trim() ||
      "https://services.leadconnectorhq.com/oauth/token",
    ghlScopes: scopes,
    encryptionSecret,
    oauthStateSecret,
    policyDiagnosticToken: process.env.POLICY_DIAGNOSTIC_TOKEN?.trim() || undefined,
  };
}

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
