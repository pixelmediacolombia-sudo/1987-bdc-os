import type { Pool } from "pg";

export const RUNTIME_ROLE_PRIVILEGES_SQL = `
GRANT USAGE ON SCHEMA public TO bdc;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bdc;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO bdc;
`;

export async function ensureRuntimeRolePrivileges(pool: Pool): Promise<void> {
  await pool.query(`
    DO $runtime_role$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO bdc', current_database());
    END
    $runtime_role$;
  `);
  await pool.query(RUNTIME_ROLE_PRIVILEGES_SQL);
  await pool.query(`
    DO $route_privileges$
    DECLARE relation_name text;
    BEGIN
      FOREACH relation_name IN ARRAY ARRAY[
        'meta_messaging_routes',
        'tenant_location_routes',
        'tenant_processing_routes'
      ] LOOP
        IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM bdc', relation_name);
        END IF;
      END LOOP;
    END;
    $route_privileges$;
  `);
}
