export const GHL_PROVIDER = "ghl" as const;

export type IntegrationHealthState = "healthy" | "degraded" | "revoked" | "unknown";

export type GhlIntegration = {
  tenantId: string;
  provider: typeof GHL_PROVIDER;
  scopes: string[];
  healthState: IntegrationHealthState;
};
