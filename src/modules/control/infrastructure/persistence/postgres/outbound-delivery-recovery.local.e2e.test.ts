import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { RegisteredOutboundMessageSender, OutboundMessageDeliveryUncertainError } from "@/modules/control/application/registered-outbound-message-sender";
import { OutboundDeliveryReconciliationService } from "@/modules/control/application/outbound-delivery-reconciliation.service";
import { PostgresOutboundMessageRegistry } from "@/modules/control/infrastructure/persistence/postgres/postgres-outbound-message-registry";

test("local PostgreSQL recovers a provider-accepted delivery after restart without resending", {
  skip: !process.env.LOCAL_WHATSAPP_DATABASE_URL,
}, async () => {
  const tenantId = "00000000-0000-0000-0000-000000000901";
  const contactId = `local-recovery-${randomUUID()}`;
  const providerMessageId = `provider-${randomUUID()}`;
  const correlationId = `local-correlation-${randomUUID()}`;
  const semanticHash = randomUUID();
  const firstPool = new Pool({ connectionString: process.env.LOCAL_WHATSAPP_DATABASE_URL });
  let attemptId: string | undefined;
  let providerSends = 0;
  let providerLookups = 0;
  try {
    const durableRegistry = new PostgresOutboundMessageRegistry(firstPool);
    const registryWithAssociationOutage = {
      ...durableRegistry,
      register: durableRegistry.register.bind(durableRegistry),
      markFailed: durableRegistry.markFailed.bind(durableRegistry),
      markDeliveryUncertain: async (input: { tenantId: string; attemptId: string; providerMessageId: string; reason: string }) => {
        await durableRegistry.markDeliveryUncertain?.call(durableRegistry, input);
      },
      attachProviderMessageId: async (_input: { tenantId: string; attemptId: string; providerMessageId: string }) => {
        throw new Error("local association outage after provider acceptance");
      },
      wasIssuedBy1987: durableRegistry.wasIssuedBy1987.bind(durableRegistry),
    };
    const sender = new RegisteredOutboundMessageSender(registryWithAssociationOutage as never, {
      send: async () => {
        providerSends += 1;
        return { providerMessageId };
      },
    });
    try {
      await sender.send({
        tenantId, contactId, content: "synthetic local evidence", semanticHash,
        correlationId, channel: "WhatsApp",
      });
      assert.fail("expected durable uncertain delivery after the simulated local association failure");
    } catch (error) {
      assert.ok(error instanceof OutboundMessageDeliveryUncertainError);
      assert.equal(error.providerMessageId, providerMessageId);
      assert.equal(error.persisted, true);
      attemptId = error.attemptId;
    }

    // New registry/service instances simulate process restart. They can only
    // reconcile the provider ID; this path has no provider send capability.
    const restartedPool = new Pool({ connectionString: process.env.LOCAL_WHATSAPP_DATABASE_URL });
    try {
      const restartedRegistry = new PostgresOutboundMessageRegistry(restartedPool);
      const reconciliation = new OutboundDeliveryReconciliationService(restartedRegistry, {
        lookup: async (input) => {
          providerLookups += 1;
          assert.equal(input.tenantId, tenantId);
          assert.equal(input.contactId, contactId);
          assert.equal(input.providerMessageId, providerMessageId);
          assert.equal(input.correlationId, correlationId);
          return { result: "found", providerStatus: "delivered" };
        },
      });
      assert.deepEqual(await reconciliation.runOnce(tenantId, "local-evidence-reviewer"), {
        inspected: 1, confirmed: 1, notFound: 0, stillUnknown: 0,
      });
      const client = await restartedPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await client.query<{
          status: string;
          resolution: string;
          resolved_by: string;
          reconciliation_attempts: number;
          last_provider_status: string;
          provider_message_id: string;
          correlation_id: string;
          created_at: Date;
          uncertainty_detected_at: Date;
          resolved_at: Date;
        }>(
          `SELECT status, resolution, resolved_by, reconciliation_attempts, last_provider_status,
                  provider_message_id, correlation_id, created_at, uncertainty_detected_at, resolved_at
             FROM public.outbound_message_registry WHERE tenant_id=$1 AND attempt_id=$2`,
          [tenantId, attemptId],
        );
        const row = result.rows[0];
        assert.ok(row);
        assert.equal(row.status, "sent");
        assert.equal(row.resolution, "confirmed");
        assert.equal(row.resolved_by, "local-evidence-reviewer");
        assert.equal(row.reconciliation_attempts, 1);
        assert.equal(row.last_provider_status, "delivered");
        assert.equal(row.provider_message_id, providerMessageId);
        assert.equal(row.correlation_id, correlationId);
        assert.ok(row.created_at instanceof Date);
        assert.ok(row.uncertainty_detected_at instanceof Date);
        assert.ok(row.resolved_at instanceof Date);
        assert.equal(providerSends, 1);
        assert.equal(providerLookups, 1);
        console.log(JSON.stringify({
          evidence: "local_postgres_uncertain_delivery_recovered",
          attemptId,
          providerMessageId,
          correlationId,
          finalStatus: row.status,
          resolution: row.resolution,
          reviewer: row.resolved_by,
          providerSends,
          providerLookups,
          timestampsPresent: true,
        }));
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await restartedPool.end();
    }
  } finally {
    if (attemptId) {
      const cleanup = await firstPool.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await cleanup.query("DELETE FROM public.outbound_message_registry WHERE tenant_id=$1 AND attempt_id=$2", [tenantId, attemptId]);
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        cleanup.release();
      }
    }
    await firstPool.end();
  }
});
