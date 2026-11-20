import type { Pool } from "pg";
import type { SecretCryptor } from "@/modules/security/application/secret-cryptor.port";
import type { MetaMessagingConnection, MetaMessagingConnectionPort } from "@/features/meta/application/meta-messaging-connection.port";

export type SaveMetaMessagingConnectionInput = {
  tenantId: string;
  facebookPageId?: string;
  instagramBusinessId?: string;
  whatsappPhoneNumberId?: string;
  pageAccessToken?: string;
  whatsappAccessToken?: string;
  grantedScopes: string[];
};

export class PostgresMetaMessagingConnectionRepository implements MetaMessagingConnectionPort {
  constructor(private readonly pool: Pool, private readonly cryptor: SecretCryptor) {}

  async getForTenant(tenantId: string): Promise<MetaMessagingConnection | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query<{
        facebook_page_id: string | null;
        instagram_business_id: string | null;
        whatsapp_phone_number_id: string | null;
        encrypted_page_access_token: string | null;
        encrypted_whatsapp_access_token: string | null;
      }>(
        `SELECT facebook_page_id, instagram_business_id, whatsapp_phone_number_id,
                encrypted_page_access_token, encrypted_whatsapp_access_token
           FROM public.meta_messaging_connections WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        ...(row.encrypted_page_access_token ? { pageAccessToken: this.cryptor.decrypt(row.encrypted_page_access_token) } : {}),
        ...(row.encrypted_whatsapp_access_token ? { whatsappAccessToken: this.cryptor.decrypt(row.encrypted_whatsapp_access_token) } : {}),
        ...(row.facebook_page_id ? { pageId: row.facebook_page_id } : {}),
        ...(row.instagram_business_id ? { instagramBusinessId: row.instagram_business_id } : {}),
        ...(row.whatsapp_phone_number_id ? { whatsappPhoneNumberId: row.whatsapp_phone_number_id } : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async save(input: SaveMetaMessagingConnectionInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
      await client.query(
        `INSERT INTO public.meta_messaging_connections
           (tenant_id, facebook_page_id, instagram_business_id, whatsapp_phone_number_id,
            encrypted_page_access_token, encrypted_whatsapp_access_token, granted_scopes, health_state, connected_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], 'healthy', now(), now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           facebook_page_id = EXCLUDED.facebook_page_id,
           instagram_business_id = EXCLUDED.instagram_business_id,
           whatsapp_phone_number_id = EXCLUDED.whatsapp_phone_number_id,
           encrypted_page_access_token = EXCLUDED.encrypted_page_access_token,
           encrypted_whatsapp_access_token = EXCLUDED.encrypted_whatsapp_access_token,
           granted_scopes = EXCLUDED.granted_scopes,
           health_state = 'healthy', connected_at = now(), updated_at = now()`,
        [input.tenantId, input.facebookPageId ?? null, input.instagramBusinessId ?? null,
          input.whatsappPhoneNumberId ?? null,
          input.pageAccessToken ? this.cryptor.encrypt(input.pageAccessToken) : null,
          input.whatsappAccessToken ? this.cryptor.encrypt(input.whatsappAccessToken) : null,
          input.grantedScopes],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
