import "dotenv/config";

export type AppConfig = {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  pgSsl: boolean;
  ghlClientId: string;
  ghlClientSecret: string;
  ghlAppVersionId: string;
  ghlRedirectUri: string;
  ghlAuthorizationUrl: string;
  ghlTokenUrl: string;
  ghlScopes: string[];
  encryptionSecret: string;
  oauthStateSecret: string;
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
  };
}
