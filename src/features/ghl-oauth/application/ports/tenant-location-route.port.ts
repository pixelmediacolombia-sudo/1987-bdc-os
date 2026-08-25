export interface TenantLocationRouteRepository {
  resolveTenantId(locationId: string): Promise<string | undefined>;
}
