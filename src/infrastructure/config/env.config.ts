import "dotenv/config";
import { loadMetaCapiEnvConfig, type MetaCapiTenantConfig } from "@/modules/control/infrastructure/meta-capi.config";

export type AppConfig = {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  migrationDatabaseUrl?: string;
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
  metaAppSecret?: string;
  metaAppId?: string;
  metaOAuthRedirectUri?: string;
  metaOAuthAuthorizationBaseUrl: string;
  metaOAuthScopes: string[];
  metaWebhookVerifyToken?: string;
  metaGraphApiBaseUrl: string;
  metaGraphApiVersion: string;
  sofiaEnabled: boolean;
  sofiaDealerName: string;
  conversationalAiEnabled: boolean;
  conversationalAiSendEnabled: boolean;
  conversationalModelBaseUrl: string;
  conversationalModelApiKey?: string;
  conversationalExtractionModel: string;
  conversationalDraftingModel: string;
  conversationalModelTimeoutMs: number;
  mediaUnderstandingEnabled: boolean;
  automationEngineEnabled: boolean;
  automationEnginePollMs: number;
  whisperCliPath?: string;
  whisperModelPath?: string;
  ffmpegCliPath?: string;
  tesseractCliPath?: string;
  encryptionSecret: string;
  oauthStateSecret: string;
  internalDiagnosticsEnabled: boolean;
  internalDiagnosticCredentials: Record<string, { token: string; actor: string }>;
  internalDiagnosticAllowedRemoteIps: string[];
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
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const encryptionSecret = required("ENCRYPTION_SECRET");
  const oauthStateSecret = required("OAUTH_STATE_SECRET");
  const metaCapi = loadMetaCapiEnvConfig();
  const conversationalAiEnabled = booleanEnv("CONVERSATIONAL_AI_ENABLED", false);
  const conversationalModelApiKey = process.env.CONVERSATIONAL_MODEL_API_KEY?.trim() || undefined;
  if (conversationalAiEnabled && !conversationalModelApiKey) throw new Error("CONVERSATIONAL_MODEL_API_KEY is required when CONVERSATIONAL_AI_ENABLED=true");

  if (Buffer.byteLength(encryptionSecret, "utf8") < 32) {
    throw new Error("ENCRYPTION_SECRET must contain at least 32 UTF-8 bytes");
  }
  if (Buffer.byteLength(oauthStateSecret, "utf8") < 32) {
    throw new Error("OAUTH_STATE_SECRET must contain at least 32 UTF-8 bytes");
  }

  const internalDiagnosticsEnabled = booleanEnv("INTERNAL_DIAGNOSTICS_ENABLED", false);
  const internalDiagnosticCredentials = parseInternalDiagnosticCredentials(
    process.env.INTERNAL_DIAGNOSTIC_CREDENTIALS_JSON,
  );
  const internalDiagnosticAllowedRemoteIps = (process.env.INTERNAL_DIAGNOSTIC_ALLOWED_REMOTE_IPS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (internalDiagnosticsEnabled && Object.keys(internalDiagnosticCredentials).length === 0) {
    throw new Error("INTERNAL_DIAGNOSTIC_CREDENTIALS_JSON is required when internal diagnostics are enabled");
  }
  if (internalDiagnosticsEnabled && nodeEnv === "production" && internalDiagnosticAllowedRemoteIps.length === 0) {
    throw new Error("INTERNAL_DIAGNOSTIC_ALLOWED_REMOTE_IPS is required for production internal diagnostics");
  }

  return {
    nodeEnv,
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    databaseUrl: required("DATABASE_URL"),
    migrationDatabaseUrl: process.env.DATABASE_MIGRATION_URL?.trim() || undefined,
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
    metaAppSecret: process.env.META_APP_SECRET?.trim() || undefined,
    metaAppId: process.env.META_APP_ID?.trim() || undefined,
    metaOAuthRedirectUri: process.env.META_OAUTH_REDIRECT_URI?.trim() || undefined,
    metaOAuthAuthorizationBaseUrl: process.env.META_OAUTH_AUTHORIZATION_BASE_URL?.trim() || "https://www.facebook.com",
    metaOAuthScopes: (process.env.META_OAUTH_SCOPES ?? "pages_show_list,pages_manage_metadata,pages_read_engagement,pages_messaging,instagram_basic,instagram_manage_messages,business_management,whatsapp_business_management,whatsapp_business_messaging")
      .split(/[\s,]+/).filter(Boolean),
    metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || undefined,
    metaGraphApiBaseUrl: process.env.META_GRAPH_API_BASE_URL?.trim() || "https://graph.facebook.com",
    metaGraphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || "v27.0",
    sofiaEnabled: booleanEnv("SOFIA_ENABLED", false),
    sofiaDealerName: process.env.SOFIA_DEALER_NAME?.trim() || "el dealer",
    conversationalAiEnabled,
    conversationalAiSendEnabled: booleanEnv("CONVERSATIONAL_AI_SEND_ENABLED", false),
    conversationalModelBaseUrl: process.env.CONVERSATIONAL_MODEL_BASE_URL?.trim() || "https://api.openai.com/v1",
    ...(conversationalModelApiKey ? { conversationalModelApiKey } : {}),
    conversationalExtractionModel: process.env.CONVERSATIONAL_EXTRACTION_MODEL?.trim() || "gpt-5.6-luna",
    conversationalDraftingModel: process.env.CONVERSATIONAL_DRAFTING_MODEL?.trim() || "gpt-5.6-luna",
    conversationalModelTimeoutMs: positiveNumberEnv("CONVERSATIONAL_MODEL_TIMEOUT_MS", 20_000),
    mediaUnderstandingEnabled: booleanEnv("MEDIA_UNDERSTANDING_ENABLED", false),
    automationEngineEnabled: booleanEnv("AUTOMATION_ENGINE_ENABLED", false),
    automationEnginePollMs: positiveNumberEnv("AUTOMATION_ENGINE_POLL_MS", 1000),
    whisperCliPath: process.env.WHISPER_CLI_PATH?.trim() || undefined,
    whisperModelPath: process.env.WHISPER_MODEL_PATH?.trim() || undefined,
    ffmpegCliPath: process.env.FFMPEG_CLI_PATH?.trim() || undefined,
    tesseractCliPath: process.env.TESSERACT_CLI_PATH?.trim() || undefined,
    encryptionSecret,
    oauthStateSecret,
    internalDiagnosticsEnabled,
    internalDiagnosticCredentials,
    internalDiagnosticAllowedRemoteIps,
  };
}

function parseInternalDiagnosticCredentials(
  raw: string | undefined,
): Record<string, { token: string; actor: string }> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("INTERNAL_DIAGNOSTIC_CREDENTIALS_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INTERNAL_DIAGNOSTIC_CREDENTIALS_JSON must be an object keyed by tenant UUID");
  }
  const credentials: Record<string, { token: string; actor: string }> = {};
  for (const [tenantId, value] of Object.entries(parsed)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new Error("INTERNAL_DIAGNOSTIC_CREDENTIALS_JSON contains an invalid tenant UUID");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Each internal diagnostic credential must have token and actor fields");
    }
    const credential = value as { token?: unknown; actor?: unknown };
    if (typeof credential.token !== "string" || Buffer.byteLength(credential.token, "utf8") < 32) {
      throw new Error("Each internal diagnostic token must contain at least 32 UTF-8 bytes");
    }
    if (typeof credential.actor !== "string" || !credential.actor.trim() || credential.actor.length > 160) {
      throw new Error("Each internal diagnostic credential must include an actor of 1-160 characters");
    }
    credentials[tenantId.toLowerCase()] = { token: credential.token, actor: credential.actor.trim() };
  }
  return credentials;
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
