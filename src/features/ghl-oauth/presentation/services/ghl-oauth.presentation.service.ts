import type { CompleteGhlOAuthUseCase } from "@/features/ghl-oauth/application/use-cases/complete-ghl-oauth.use-case";
import type { InitiateGhlOAuthUseCase } from "@/features/ghl-oauth/application/use-cases/initiate-ghl-oauth.use-case";

/**
 * Presentation orchestration only: adapts HTTP inputs to application use cases.
 * Business invariants remain in application/domain and are not placed in Express.
 */
export class GhlOAuthPresentationService {
  constructor(
    private readonly initiateUseCase: InitiateGhlOAuthUseCase,
    private readonly completeUseCase: CompleteGhlOAuthUseCase,
  ) {}

  initiate(input: { tenantId?: string }): { authorizationUrl: string } {
    return this.initiateUseCase.execute(input);
  }

  complete(input: { code: string; state: string }): Promise<{ tenantId: string; locationId: string }> {
    return this.completeUseCase.execute(input);
  }
}
