import type { Pool } from "pg";
import type {
  SaveGhlInstallationInput,
  StoredGhlIntegration,
  TenantIntegrationRepository,
  UpdateGhlTokensInput,
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
           (tenant_id, provider, ghl_location_id, encrypted_access_token, encrypted_refresh_token, scopes, access_token_expires_at, health_state)
         VALUES ($1, 'ghl', $2, $3, $4, $5::text[], $6, 'healthy')
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           ghl_location_id = EXCLUDED.ghl_location_id,
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           scopes = EXCLUDED.scopes,
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           health_state = 'healthy',
           updated_at = now()`,
        [
          tenantId,
          input.locationId,
          input.encryptedAccessToken,
          input.encryptedRefreshToken ?? null,
          input.scopes,
          input.accessTokenExpiresAt ?? null,
        ],
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

  async getGhlIntegration(tenantId: string): Promise<StoredGhlIntegration | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, tenantId);
      const result = await client.query<{
        id: string;
        tenant_id: string;
        encrypted_access_token: string;
        encrypted_refresh_token: string | null;
        scopes: string[];
        access_token_expires_at: Date | null;
      }>(
        `SELECT id, tenant_id, encrypted_access_token, encrypted_refresh_token, scopes, access_token_expires_at
           FROM public.integrations
          WHERE tenant_id = $1 AND provider = 'ghl'`,
        [tenantId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        encryptedAccessToken: row.encrypted_access_token,
        ...(row.encrypted_refresh_token ? { encryptedRefreshToken: row.encrypted_refresh_token } : {}),
        scopes: row.scopes,
        ...(row.access_token_expires_at ? { accessTokenExpiresAt: row.access_token_expires_at } : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateGhlTokens(input: UpdateGhlTokensInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, input.tenantId);
      const integration = await client.query<{ id: string }>(
        `SELECT id FROM public.integrations
          WHERE tenant_id = $1 AND provider = 'ghl'
          FOR UPDATE`,
        [input.tenantId],
      );
      if (integration.rowCount !== 1 || !integration.rows[0]) throw new Error("GHL integration was not found");

      await client.query(
        `UPDATE public.integrations
            SET encrypted_access_token = $2,
                encrypted_refresh_token = $3,
                scopes = $4::text[],
                access_token_expires_at = $5,
                health_state = 'healthy',
                updated_at = now()
          WHERE id = $1`,
        [
          integration.rows[0].id,
          input.encryptedAccessToken,
          input.encryptedRefreshToken ?? null,
          input.scopes,
          input.accessTokenExpiresAt ?? null,
        ],
      );
      await client.query(
        `INSERT INTO public.integration_token_audits (tenant_id, integration_id, action, metadata)
         VALUES ($1, $2, 'token_refreshed', $3::jsonb)`,
        [input.tenantId, integration.rows[0].id, JSON.stringify({ source: "automatic_refresh" })],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async setTenantContext(client: import("pg").PoolClient, tenantId: string): Promise<void> {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  }
}
