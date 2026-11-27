import type { Pool } from "pg";
import { withTenant, withUser } from "@/features/identity/infrastructure/persistence/postgres/tenant-transaction";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function isTenantMember(pool: Pool, userId: string, tenantId: string): Promise<boolean> {
  if (!UUID.test(tenantId)) return false;
  const member = await withUser(pool, userId, async (client) =>
    (await client.query(
      "SELECT 1 FROM public.user_tenant_memberships WHERE user_id = $1 AND tenant_id = $2::uuid",
      [userId, tenantId],
    )).rowCount === 1,
  );
  if (!member) return false;
  return withTenant(pool, tenantId, async (client) =>
    (await client.query(
      "SELECT 1 FROM public.tenants WHERE dealer_id = $1::uuid AND status = 'active'",
      [tenantId],
    )).rowCount === 1,
  );
}
