import type { Pool } from "pg";
import { GhlTokenRefreshUseCase } from "@/features/ghl-oauth/application/use-cases/ghl-token-refresh.use-case";
import type { GhlOAuthClient } from "@/features/ghl-oauth/application/ports/ghl-oauth-client.port";
import type { SecretCryptor } from "@/features/ghl-oauth/application/ports/secret-cryptor.port";
import type { TenantIntegrationRepository } from "@/features/ghl-oauth/application/ports/tenant-integration-repository.port";
import { GhlApiClient } from "@/features/ghl-oauth/infrastructure/ghl/ghl-api.client";
import { GhlOutboundMessageProvider } from "@/features/ghl-oauth/infrastructure/ghl/ghl-outbound-message.provider";
import { SemanticRepetitionValidator } from "@/modules/control/application/SemanticRepetitionValidator";
import { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import { RegisteredOutboundMessageSender } from "@/modules/control/application/registered-outbound-message-sender";
import type { OutboundMessageRegistryPort } from "@/modules/control/application/ports/outbound-message-registry.port";
import type { PolicyEvaluatorPort } from "@/modules/decisions/application/policy-evaluation.service";

export type QualificationFlowCompositionDependencies = {
  pool: Pool;
  oauthClient: GhlOAuthClient;
  integrationRepository: TenantIntegrationRepository;
  cryptor: SecretCryptor;
  outboundRegistry: OutboundMessageRegistryPort;
  policyEvaluator: PolicyEvaluatorPort;
};

/** Builds the protected Ticket 8 flow without enabling it by itself. */
export function createQualificationFlow(
  dependencies: QualificationFlowCompositionDependencies,
): QualificationFlowService {
  const tokenRefresh = new GhlTokenRefreshUseCase(
    dependencies.oauthClient,
    dependencies.integrationRepository,
    dependencies.cryptor,
  );
  const ghlApiClient = new GhlApiClient(tokenRefresh);
  const sender = new RegisteredOutboundMessageSender(
    dependencies.outboundRegistry,
    new GhlOutboundMessageProvider(ghlApiClient),
    new SemanticRepetitionValidator(dependencies.pool),
  );
  return new QualificationFlowService(dependencies.policyEvaluator, sender);
}
