import type { Pool } from "pg";
import type { InternalDiagnosticAuditPort } from "@/presentation/http/internal-diagnostic-guard";

export class PostgresInternalDiagnosticAudit implements InternalDiagnosticAuditPort {
  constructor(private readonly pool: Pool) {}

  async start(input: Parameters<InternalDiagnosticAuditPort["start"]>[0]): Promise<string> {
    return this.withTenantContext(input.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO public.internal_diagnostic_access_audit
           (tenant_id, actor, request_id, method, route, remote_address)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text AS id`,
        [input.tenantId, input.actor, input.requestId, input.method, input.route, input.remoteAddress],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("Internal diagnostic audit insert returned no id");
      return id;
    });
  }

  async finish(input: Parameters<InternalDiagnosticAuditPort["finish"]>[0]): Promise<void> {
    await this.withTenantContext(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE public.internal_diagnostic_access_audit
            SET status_code = $3, completed_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, input.auditId, input.statusCode],
      );
      if (result.rowCount !== 1) throw new Error("Internal diagnostic audit event was not found");
    });
  }

  private async withTenantContext<T>(tenantId: string, operation: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
