import type { GhlOAuthClient } from "@/features/ghl-oauth/application/ports/ghl-oauth-client.port";
import type { OAuthStateService } from "@/features/ghl-oauth/application/ports/oauth-state.port";
import { randomUUID } from "node:crypto";

export class InitiateGhlOAuthUseCase {
  constructor(
    private readonly oauthClient: GhlOAuthClient,
    private readonly stateService: OAuthStateService,
  ) {}

  execute(input: { tenantId?: string }): { authorizationUrl: string } {
    const state = this.stateService.create({
      issuedAt: Date.now(),
      nonce: randomUUID(),
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    });
    return { authorizationUrl: this.oauthClient.createAuthorizationUrl({ state }) };
  }
}
