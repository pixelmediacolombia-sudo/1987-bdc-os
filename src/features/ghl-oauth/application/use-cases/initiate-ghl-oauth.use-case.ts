import type { GhlOAuthClient } from "@/features/ghl-oauth/application/ports/ghl-oauth-client.port";
import type { OAuthStateService } from "@/features/ghl-oauth/application/ports/oauth-state.port";
import type { TenantLocationRouteRepository } from "@/features/ghl-oauth/application/ports/tenant-location-route.port";
import { randomUUID } from "node:crypto";

export class InitiateGhlOAuthUseCase {
  constructor(
    private readonly oauthClient: GhlOAuthClient,
    private readonly stateService: OAuthStateService,
    private readonly routeRepository: TenantLocationRouteRepository,
  ) {}

  async execute(input: { tenantId?: string; locationId?: string }): Promise<{ authorizationUrl: string }> {
    const tenantId = input.tenantId ?? (input.locationId
      ? await this.routeRepository.resolveTenantId(input.locationId)
      : undefined);
    if (!tenantId) throw new Error("OAuth tenant route was not found");

    const state = this.stateService.create({
      issuedAt: Date.now(),
      nonce: randomUUID(),
      tenantId,
    });
    return { authorizationUrl: this.oauthClient.createAuthorizationUrl({ state }) };
  }
}
