import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { bootstrapLocalAdmin } from "./local-admin.bootstrap";
import { CREATE_IDENTITY_TABLES_SQL, ensureIdentityTables } from "./identity.migration";

test("identity schema separates global accounts from dealer tenants and permits one admin", () => {
  assert.match(CREATE_IDENTITY_TABLES_SQL, /CREATE TABLE IF NOT EXISTS public\.app_users/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /account_type IN \('admin', 'user'\)/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /app_users_single_platform_admin_uq[\s\S]*WHERE account_type = 'admin'/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /public\.user_tenant_memberships/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /REFERENCES public\.tenants\(dealer_id\)/);
  assert.doesNotMatch(CREATE_IDENTITY_TABLES_SQL, /password\s*=\s*['"]/i);
});

test("identity migration runs in one transaction", async () => {
  const calls: string[] = [];
  const pool = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; } } as unknown as Pool;
  await ensureIdentityTables(pool);
  assert.deepEqual(calls, ["BEGIN", CREATE_IDENTITY_TABLES_SQL, "COMMIT"]);
});

test("local admin bootstrap refuses non-development and incomplete credentials", async () => {
  const pool = { query: async () => { throw new Error("must not query"); } } as unknown as Pool;
  await assert.rejects(
    bootstrapLocalAdmin(pool, { NODE_ENV: "production", BDC_ADMIN_EMAIL: "admin@example.com" }),
    /only when NODE_ENV=development/,
  );
  await assert.rejects(
    bootstrapLocalAdmin(pool, { NODE_ENV: "development", BDC_ADMIN_EMAIL: "admin@example.com" }),
    /must all be set/,
  );
});

test("local admin bootstrap inserts one normalized admin without overwriting an existing admin", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT")) return { rows: [] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const inserted = await bootstrapLocalAdmin(pool, {
    NODE_ENV: "development",
    BDC_ADMIN_EMAIL: " Admin@Example.com ",
    BDC_ADMIN_NAME: "Local Admin",
    BDC_ADMIN_PASSWORD_HASH: `scrypt$32768$8$1$${"a".repeat(22)}$${"b".repeat(86)}`,
  });
  assert.equal(inserted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.values?.[0], "admin@example.com");
  assert.equal(calls[1]?.values?.[2]?.toString().startsWith("scrypt$"), true);
});

test("local admin bootstrap is idempotent for its configured email and rejects a second admin", async () => {
  const hash = `scrypt$32768$8$1$${"a".repeat(22)}$${"b".repeat(86)}`;
  const environment = {
    NODE_ENV: "development",
    BDC_ADMIN_EMAIL: "admin@example.com",
    BDC_ADMIN_NAME: "Local Admin",
    BDC_ADMIN_PASSWORD_HASH: hash,
  };
  const existingAdmin = (email: string) => ({
    query: async () => ({ rows: [{ id: "local-admin", email }] }),
  }) as unknown as Pool;

  assert.equal(await bootstrapLocalAdmin(existingAdmin("ADMIN@example.com"), environment), false);
  await assert.rejects(bootstrapLocalAdmin(existingAdmin("other@example.com"), environment), /already exists locally/);
});
