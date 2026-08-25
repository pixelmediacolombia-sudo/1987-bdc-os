import { loadAppConfig } from "@/features/ghl-oauth/infrastructure/config/env.config";
import { createPostgresPool } from "@/features/ghl-oauth/infrastructure/persistence/postgres/pool";
import { identifyMetaCapiDealerKey } from "@/modules/control/infrastructure/meta-capi.config";

type DealerCheck = {
  dealerId: string;
  dealerKey?: string;
  ghlLocationId?: string;
  metaCapiEnabled: boolean;
  metaDatasetConfigured: boolean;
  metaTokenConfigured: boolean;
  ctwaCandidates: number;
  contactsWithCtwa: number;
  rawWebhookTotal: number;
  rawWebhookOldest?: string;
  rawWebhookNewest?: string;
  whatsappWebhookTotal: number;
  qualificationCompletionsLast7Days: number;
  capiByStatus: Record<string, number>;
  ghlTagByStatus: Record<string, number>;
  capiPayloadsWithAccessToken: number;
  productionTestCodes: number;
};

async function main(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  try {
    const schema = await pool.query<{
      contacts: string | null;
      capi_events: string | null;
      ghl_tags: string | null;
      raw_webhooks: string | null;
      ctwa_column: string;
      meta_column: string;
    }>(
      `SELECT to_regclass('public.contacts') AS contacts,
              to_regclass('public.capi_events') AS capi_events,
              to_regclass('public.ghl_qualification_tag_events') AS ghl_tags,
              to_regclass('public.raw_webhooks') AS raw_webhooks,
              (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'ctwa_clid')::text AS ctwa_column,
              (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'meta_dataset_id')::text AS meta_column`,
    );
    // tenants is FORCE RLS and the verifier starts without app.tenant_id.
    // Enumerate bootstrap routes instead; each route is then checked under
    // its own tenant context below. The previous SECURITY DEFINER function
    // returned dealers=0 for a normal bdc role even when routes existed.
    const routeRows = await pool.query<{ dealer_id: string }>(
      "SELECT dealer_id::text AS dealer_id FROM public.tenant_location_routes ORDER BY dealer_id",
    );
    const dealers = { rows: routeRows.rows };
    const checks: DealerCheck[] = [];
    for (const dealer of dealers.rows) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealer.dealer_id]);
        const tenant = await client.query<{
          ghl_location_id: string | null;
          meta_capi_enabled: boolean;
          meta_dataset_id: string | null;
          encrypted_meta_access_token: string | null;
          tenant_document: string;
        }>(
          `SELECT ghl_location_id, meta_capi_enabled, meta_dataset_id,
                  encrypted_meta_access_token, to_jsonb(t)::text AS tenant_document
             FROM public.tenants AS t
            WHERE dealer_id = $1
            LIMIT 1`,
          [dealer.dealer_id],
        );
        const audit = await client.query<{
          total: string;
          oldest: Date | null;
          newest: Date | null;
          whatsapp_total: string;
          ctwa_candidates: string;
          contacts_with_ctwa: string;
        }>(
          `SELECT
             COUNT(*)::text AS total,
             MIN(received_at) AS oldest,
             MAX(received_at) AS newest,
             COUNT(*) FILTER (WHERE payload::text ILIKE '%whatsapp%')::text AS whatsapp_total,
             COUNT(*) FILTER (WHERE payload::text ILIKE '%ctwa%'
                              OR payload::text ILIKE '%referral%'
                              OR payload::text ILIKE '%source_id%')::text AS ctwa_candidates,
             (SELECT COUNT(*)::text FROM public.contacts WHERE ctwa_clid IS NOT NULL) AS contacts_with_ctwa
             FROM public.raw_webhooks`,
        );
        const capi = await client.query<{ status: string; count: string }>(
          "SELECT status, COUNT(*)::text AS count FROM public.capi_events GROUP BY status",
        );
        const tags = await client.query<{ status: string; count: string }>(
          "SELECT status, COUNT(*)::text AS count FROM public.ghl_qualification_tag_events GROUP BY status",
        );
        const completions = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM public.objectives AS objective
            WHERE objective.qualification_completed = true
              AND objective.qualification_completed_at >= now() - interval '7 days'
              AND EXISTS (
                SELECT 1
                  FROM public.sofia_conversation_state AS sofia
                 WHERE sofia.tenant_id = objective.tenant_id
                   AND sofia.contact_id = objective.contact_id
                   AND sofia.lead_level IN ('A', 'B')
              )`,
        );
        const tokenPayloads = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM public.capi_events
            WHERE payload_sent::text ILIKE '%access_token%'`,
        );
        const testCodes = await client.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM public.tenants WHERE meta_test_event_code IS NOT NULL",
        );
        await client.query("COMMIT");
        checks.push({
          dealerId: dealer.dealer_id,
          ...(tenant.rows[0]?.tenant_document ? { dealerKey: identifyMetaCapiDealerKey(tenant.rows[0].tenant_document) } : {}),
          ...(tenant.rows[0]?.ghl_location_id ? { ghlLocationId: tenant.rows[0].ghl_location_id } : {}),
          metaCapiEnabled: tenant.rows[0]?.meta_capi_enabled ?? false,
          metaDatasetConfigured: Boolean(tenant.rows[0]?.meta_dataset_id),
          metaTokenConfigured: Boolean(tenant.rows[0]?.encrypted_meta_access_token),
          ctwaCandidates: Number(audit.rows[0]?.ctwa_candidates ?? 0),
          contactsWithCtwa: Number(audit.rows[0]?.contacts_with_ctwa ?? 0),
          rawWebhookTotal: Number(audit.rows[0]?.total ?? 0),
          ...(audit.rows[0]?.oldest ? { rawWebhookOldest: audit.rows[0].oldest.toISOString() } : {}),
          ...(audit.rows[0]?.newest ? { rawWebhookNewest: audit.rows[0].newest.toISOString() } : {}),
          whatsappWebhookTotal: Number(audit.rows[0]?.whatsapp_total ?? 0),
          qualificationCompletionsLast7Days: Number(completions.rows[0]?.count ?? 0),
          capiByStatus: Object.fromEntries(capi.rows.map((row) => [row.status, Number(row.count)])),
          ghlTagByStatus: Object.fromEntries(tags.rows.map((row) => [row.status, Number(row.count)])),
          capiPayloadsWithAccessToken: Number(tokenPayloads.rows[0]?.count ?? 0),
          productionTestCodes: config.nodeEnv === "production" ? Number(testCodes.rows[0]?.count ?? 0) : 0,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    const productionTestCodes = checks.reduce((sum, check) => sum + check.productionTestCodes, 0);
    if (config.nodeEnv === "production" && productionTestCodes > 0) {
      throw new Error("Ticket 8.5 verification failed: meta_test_event_code is populated in production");
    }
    console.log(JSON.stringify({
      ticket: "8.5",
      nodeEnv: config.nodeEnv,
      schema: schema.rows[0],
      dealers: checks.length,
      checks,
      tenantRouteCount: routeRows.rowCount ?? routeRows.rows.length,
      enumeration: "tenant_location_routes (bootstrap metadata) followed by app.tenant_id-scoped checks",
      note: checks.length === 0 ? "No tenant routes were visible; schema check is authoritative for this run." : undefined,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Ticket 8.5 verification failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
