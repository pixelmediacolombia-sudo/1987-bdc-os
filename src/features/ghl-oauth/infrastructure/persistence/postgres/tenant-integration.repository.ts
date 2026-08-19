import type { Pool } from "pg";
import type {
  SaveGhlInstallationInput,
  TenantIntegrationRepository,
} from "@/features/ghl-oauth/application/ports/tenant-integration-repository.port";

export class PostgresTenantIntegrationRepository implements TenantIntegrationRepository {
  constructor(private readonly pool: Pool) {}

  async saveGhlInstallation(input: SaveGhlInstallationInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!input.expectedTenantId) {
        throw new Error("OAuth installation requires a pre-provisioned tenant when RLS is enabled");
      }

      // The database RLS policy scopes all tenant rows to this transaction-local tenant id.
      // The value comes from the signed OAuth state, never from the token response.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.expectedTenantId]);

      const tenant = await client.query<{ dealer_id: string; ghl_location_id: string }>(
        "SELECT dealer_id, ghl_location_id FROM public.tenants WHERE dealer_id = $1 FOR UPDATE",
        [input.expectedTenantId],
      );

      if (tenant.rowCount !== 1 || !tenant.rows[0]) throw new Error("OAuth tenant was not found");
      if (tenant.rows[0].ghl_location_id !== input.locationId) {
        throw new Error("OAuth location does not match the requested tenant");
      }

      const tenantId = tenant.rows[0].dealer_id;
      await client.query(
        `INSERT INTO public.integrations
           (tenant_id, provider, encrypted_access_token, encrypted_refresh_token, scopes, health_state)
         VALUES ($1, 'ghl', $2, $3, $4::text[], 'healthy')
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           scopes = EXCLUDED.scopes,
           health_state = 'healthy',
           updated_at = now()`,
        [tenantId, input.encryptedAccessToken, input.encryptedRefreshToken ?? null, input.scopes],
      );

      await client.query("COMMIT");
      return tenantId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
