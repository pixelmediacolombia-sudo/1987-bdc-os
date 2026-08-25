import type { Pool } from "pg";
import type { TenantLocationRouteRepository } from "@/features/ghl-oauth/application/ports/tenant-location-route.port";

export class PostgresTenantLocationRouteRepository implements TenantLocationRouteRepository {
  constructor(private readonly pool: Pool) {}

  async resolveTenantId(locationId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ dealer_id: string }>(
      `SELECT dealer_id::text AS dealer_id
         FROM public.tenant_location_routes
        WHERE ghl_location_id = $1
        LIMIT 1`,
      [locationId],
    );
    return result.rows[0]?.dealer_id;
  }
}
