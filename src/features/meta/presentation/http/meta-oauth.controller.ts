import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Request, Response } from "express";
import type { OAuthStateService } from "@/features/meta/application/oauth/oauth-state.port";
import type { MetaOAuthClient } from "@/features/meta/application/oauth/meta-oauth.client";
import type { PostgresMetaMessagingConnectionRepository } from "@/features/meta/infrastructure/persistence/postgres/postgres-meta-messaging-connection.repository";

const DEFAULT_SCOPES = [
  "pages_show_list", "pages_manage_metadata", "pages_read_engagement", "pages_messaging",
  "instagram_basic", "instagram_manage_messages", "business_management",
  "whatsapp_business_management", "whatsapp_business_messaging",
];

export class MetaOAuthController {
  constructor(
    private readonly pool: Pool,
    private readonly stateService: OAuthStateService,
    private readonly client: MetaOAuthClient | undefined,
    private readonly connections: PostgresMetaMessagingConnectionRepository,
    private readonly redirectUri: string | undefined,
    private readonly appUrl: string | undefined,
    private readonly scopes: string[] = DEFAULT_SCOPES,
  ) {}

  authorizationUrl(tenantId: string): string {
    if (!this.client) throw new Error("Meta OAuth is not configured");
    const state = this.stateService.create({ issuedAt: Date.now(), nonce: randomUUID(), tenantId });
    return this.client.authorizationUrl(state, this.scopes);
  }

  callback = async (request: Request, response: Response): Promise<void> => {
    if (!this.client || !this.redirectUri) {
      response.status(503).json({ error: "Meta OAuth is not configured" });
      return;
    }
    const code = typeof request.query.code === "string" ? request.query.code : undefined;
    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    if (!code || !state) {
      response.status(400).json({ error: "Meta OAuth callback is missing code or state" });
      return;
    }

    let tenantId: string;
    try {
      const claims = this.stateService.verify(state);
      if (!claims.tenantId || !/^[0-9a-f-]{36}$/i.test(claims.tenantId)) throw new Error("Invalid tenant state");
      tenantId = claims.tenantId;
    } catch {
      response.status(400).json({ error: "Meta OAuth state is invalid or expired" });
      return;
    }

    try {
      const tenantClient = await this.pool.connect();
      let tenant: { facebook_page_id: string | null } | undefined;
      try {
        await tenantClient.query("BEGIN");
        await tenantClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await tenantClient.query<{ facebook_page_id: string | null }>(
          "SELECT facebook_page_id FROM public.tenants WHERE dealer_id = $1 LIMIT 1", [tenantId],
        );
        tenant = result.rows[0];
        await tenantClient.query("COMMIT");
      } catch (error) {
        await tenantClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { tenantClient.release(); }
      if (!tenant) {
        response.status(404).json({ error: "Dealer for Meta connection was not found" });
        return;
      }
      const shortLived = await this.client.exchangeCode(code);
      const userToken = await this.client.exchangeLongLivedToken(shortLived.accessToken);
      const assets = await this.client.listAssets(userToken.accessToken);
      const page = tenant.facebook_page_id
        ? assets.pages.find((asset) => asset.id === tenant?.facebook_page_id)
        : assets.pages.length === 1 ? assets.pages[0] : undefined;
      if (!page && assets.pages.length > 0) {
        response.status(409).json({ error: "Meta returned multiple Pages; configure the dealer's Page ID before connecting" });
        return;
      }
      const whatsappPhoneNumberId = assets.whatsappPhoneNumberIds.length === 1 ? assets.whatsappPhoneNumberIds[0] : undefined;
      const channels = new Set(assets.grantedScopes);
      await this.connections.save({
        tenantId,
        ...(page ? { facebookPageId: page.id } : {}),
        ...(page?.instagramBusinessId && channels.has("instagram_manage_messages") ? { instagramBusinessId: page.instagramBusinessId } : {}),
        ...(whatsappPhoneNumberId && channels.has("whatsapp_business_messaging") ? { whatsappPhoneNumberId } : {}),
        ...(page ? { pageAccessToken: page.accessToken } : {}),
        ...(whatsappPhoneNumberId ? { whatsappAccessToken: userToken.accessToken } : {}),
        grantedScopes: assets.grantedScopes,
      });
      if (page) {
        const updateClient = await this.pool.connect();
        try {
          await updateClient.query("BEGIN");
          await updateClient.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
          await updateClient.query("UPDATE public.tenants SET facebook_page_id = $2 WHERE dealer_id = $1", [tenantId, page.id]);
          await updateClient.query("COMMIT");
        } catch (error) {
          await updateClient.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally { updateClient.release(); }
      }
      const result = new URL(this.appUrl ?? this.redirectUri);
      result.searchParams.set("meta_connection", "connected");
      result.searchParams.set("dealer_id", tenantId);
      response.redirect(303, result.toString());
    } catch {
      response.status(502).json({ error: "Meta connection could not be completed. Check app permissions and selected dealer assets." });
    }
  };
}
