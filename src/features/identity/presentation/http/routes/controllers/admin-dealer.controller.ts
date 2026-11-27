import express, { type Request, type Response } from "express";
import type { RequestHandler } from "express";
import type { Pool } from "pg";
import { findMetaCapiEnvConfig } from "@/modules/control/infrastructure/meta-capi.config";
import { loadAdminDealerDirectory, requireAdmin, type IdentityRouteOptions, type IdentityUser } from "../route-helpers";



export class AdminDealerController {
  constructor(private readonly pool: Pool, private readonly options: IdentityRouteOptions) {}

  getAdminDealers: RequestHandler = async (request: Request, response: Response) => {
    try {
      if (!await requireAdmin(this.pool, request, response)) return;
      const dealers = await loadAdminDealerDirectory(this.pool);
      dealers.sort((left, right) => (left.name ?? "").localeCompare(right.name ?? "", "en"));
      response.status(200).json({ dealers });
    } catch {
      response.status(500).json({ error: "No pudimos cargar los dealers." });
    }
  };

  getAdminDealersByDealerIdMetaConnect: RequestHandler = async (request: Request, response: Response) => {
    const dealerId = request.params.dealerId;
    if (typeof dealerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dealerId)) {
      response.status(400).json({ error: "El identificador del dealer no es válido." });
      return;
    }
    let admin: IdentityUser | undefined;
    try { admin = await requireAdmin(this.pool, request, response); } catch {
      response.status(500).json({ error: "No pudimos verificar la sesión." });
      return;
    }
    if (!admin) return;
    if (!this.options.metaOAuthStart) {
      response.status(503).json({ error: "La conexión Meta todavía no está configurada." });
      return;
    }
    try {
      const client = await this.pool.connect();
      let dealerExists = false;
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
        const dealer = await client.query("SELECT 1 FROM public.tenants WHERE dealer_id = $1 LIMIT 1", [dealerId]);
        dealerExists = Boolean(dealer.rowCount);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
      if (!dealerExists) { response.status(404).json({ error: "No encontramos ese dealer." }); return; }
      response.redirect(302, this.options.metaOAuthStart(dealerId));
    } catch {
      response.status(503).json({ error: "No pudimos iniciar la conexión con Meta." });
    }
  };

  getAdminDealersByDealerIdConfiguration: RequestHandler = async (request: Request, response: Response) => {
    const dealerId = request.params.dealerId;
    if (typeof dealerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dealerId)) {
      response.status(400).json({ error: "El identificador del dealer no es válido." });
      return;
    }
    try {
      if (!await requireAdmin(this.pool, request, response)) return;
      const client = await this.pool.connect();
      let dealer: {
        id: string; name: string | null; status: string; timezone: string | null; policy_version: string | null;
        financial_policy: Record<string, unknown> | null; sofia_enabled: boolean;
        qualification_flow_enabled: boolean; qualification_signal_enabled: boolean; meta_dataset_id: string | null;
        has_meta_access_token: boolean; meta_event_name: string | null; meta_capi_enabled: boolean;
        has_meta_test_event_code: boolean; facebook_page_id: string | null; conversational_ai_shadow_enabled: boolean;
        conversational_ai_send_enabled: boolean;
      } | undefined;
      let lastCapiEvent: { status: string; created_at: Date } | undefined;
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
        const dealerResult = await client.query<NonNullable<typeof dealer>>(
          `SELECT dealer_id::text AS id, dealer_name AS name, status, timezone, policy_version, financial_policy,
                  sofia_enabled, qualification_flow_enabled, qualification_signal_enabled,
                  meta_dataset_id, (encrypted_meta_access_token IS NOT NULL AND length(encrypted_meta_access_token) > 0) AS has_meta_access_token,
                  meta_event_name, meta_capi_enabled, (meta_test_event_code IS NOT NULL AND length(meta_test_event_code) > 0) AS has_meta_test_event_code,
                  facebook_page_id, conversational_ai_shadow_enabled, conversational_ai_send_enabled
             FROM public.tenants WHERE dealer_id = $1 LIMIT 1`, [dealerId],
        );
        dealer = dealerResult.rows[0];
        if (dealer) {
        const capiResult = await client.query(
          "SELECT status, created_at FROM public.capi_events WHERE dealer_id = $1 ORDER BY created_at DESC LIMIT 1", [dealerId],
        );
        lastCapiEvent = capiResult.rows[0];
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
      if (!dealer) { response.status(404).json({ error: "No encontramos ese dealer." }); return; }

      const envMeta = findMetaCapiEnvConfig(dealer.id, this.options.metaCapiDealers ?? []);
      const metaHasDealerCredential = dealer.has_meta_access_token;
      const metaCredentialSource = metaHasDealerCredential ? "dealer" : envMeta ? "environment" : "none";
      const financialPolicy = dealer.financial_policy && typeof dealer.financial_policy === "object" ? dealer.financial_policy : {};
      response.status(200).json({
        dealer: { id: dealer.id, name: dealer.name, status: dealer.status, timezone: dealer.timezone },
        policy: { version: dealer.policy_version, financialPolicyKeys: Object.keys(financialPolicy).slice(0, 30) },
        flags: {
          sofiaEnabled: dealer.sofia_enabled, qualificationFlowEnabled: dealer.qualification_flow_enabled,
          qualificationSignalEnabled: dealer.qualification_signal_enabled, metaCapiEnabled: dealer.meta_capi_enabled,
          conversationAiShadowEnabled: dealer.conversational_ai_shadow_enabled,
          conversationAiSendEnabled: dealer.conversational_ai_send_enabled,
          facebookPageConfigured: Boolean(dealer.facebook_page_id),
        },
        integrations: {
          metaCapi: {
            enabled: dealer.meta_capi_enabled, status: !dealer.meta_capi_enabled ? "disabled" : metaCredentialSource === "none" ? "incomplete" : "configured",
            credentialSource: metaCredentialSource, hasCredential: metaCredentialSource !== "none",
            datasetId: dealer.meta_dataset_id ?? envMeta?.datasetId ?? null,
            eventName: dealer.meta_event_name ?? this.options.metaCapiEventName ?? "LeadSubmitted",
            testEventCodeConfigured: dealer.has_meta_test_event_code,
            lastEventStatus: lastCapiEvent?.status ?? null, lastEventAt: lastCapiEvent?.created_at ?? null,
          },
        },
      });
    } catch {
      if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar la configuración del dealer." });
    }
  };
}
