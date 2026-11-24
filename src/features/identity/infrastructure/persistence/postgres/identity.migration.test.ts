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
  assert.match(CREATE_IDENTITY_TABLES_SQL, /public\.app_sessions/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /ALTER TABLE public\.tenants ALTER COLUMN ghl_location_id DROP NOT NULL/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /DROP TRIGGER IF EXISTS tenants_sync_location_route/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /public\.dealer_invitations/);
  assert.match(CREATE_IDENTITY_TABLES_SQL, /accepted_at IS NULL AND revoked_at IS NULL/);
  assert.doesNotMatch(CREATE_IDENTITY_TABLES_SQL, /password\s*=\s*['"]/i);
});

test("identity migration runs in one transaction", async () => {
  const calls: string[] = [];
  const pool = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; } } as unknown as Pool;
  await ensureIdentityTables(pool);
  assert.deepEqual(calls, ["BEGIN", CREATE_IDENTITY_TABLES_SQL, "COMMIT"]);
});

test("admin bootstrap refuses unsupported environments and incomplete credentials", async () => {
  const pool = { query: async () => { throw new Error("must not query"); } } as unknown as Pool;
  await assert.rejects(
    bootstrapLocalAdmin(pool, { NODE_ENV: "test", BDC_ADMIN_EMAIL: "admin@example.com" }),
    /NODE_ENV=development or production/,
  );
  await assert.rejects(
    bootstrapLocalAdmin(pool, { NODE_ENV: "development", BDC_ADMIN_EMAIL: "admin@example.com" }),
    /must all be set/,
  );
  await assert.rejects(
    bootstrapLocalAdmin(pool, { NODE_ENV: "production", BDC_ADMIN_EMAIL: "admin@example.com" }),
    /must all be set/,
  );
});

test("admin bootstrap creates the normalized account in development and production", async () => {
  const hash = "scrypt$32768$8$1$" + "a".repeat(22) + "$" + "b".repeat(86);
  for (const nodeEnvironment of ["development", "production"] as const) {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith("SELECT")) return { rows: [] };
        return { rows: [] };
      },
    } as unknown as Pool;
    const inserted = await bootstrapLocalAdmin(pool, {
      NODE_ENV: nodeEnvironment,
      BDC_ADMIN_EMAIL: " Admin@Example.com ",
      BDC_ADMIN_NAME: "Test Admin",
      BDC_ADMIN_PASSWORD_HASH: nodeEnvironment === "production" ? hash.replace(/\$/g, "$$") : hash,
    });
    assert.equal(inserted, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.values?.[0], "admin@example.com");
    assert.equal(calls[1]?.values?.[0], "admin@example.com");
    assert.equal(calls[1]?.values?.[2], hash);
  }
});

test("admin bootstrap is idempotent and never replaces a different production admin", async () => {
  const hash = "scrypt$32768$8$1$" + "a".repeat(22) + "$" + "b".repeat(86);
  const environment = (NODE_ENV: "development" | "production") => ({
    NODE_ENV,
    BDC_ADMIN_EMAIL: "admin@example.com",
    BDC_ADMIN_NAME: "Test Admin",
    BDC_ADMIN_PASSWORD_HASH: hash,
  });
  const existingAdmin = (email: string) => ({
    query: async () => ({ rows: [{ id: "platform-admin", email, account_type: "admin" as const }] }),
  }) as unknown as Pool;

  assert.equal(await bootstrapLocalAdmin(existingAdmin("ADMIN@example.com"), environment("development")), false);
  assert.equal(await bootstrapLocalAdmin(existingAdmin("ADMIN@example.com"), environment("production")), false);
  await assert.rejects(bootstrapLocalAdmin(existingAdmin("other@example.com"), environment("development")), /already exists locally/);
  assert.equal(await bootstrapLocalAdmin(existingAdmin("other@example.com"), environment("production")), false);
});

test("production admin bootstrap never elevates an existing regular account", async () => {
  const hash = "scrypt$32768$8$1$" + "a".repeat(22) + "$" + "b".repeat(86);
  let insertCalled = false;
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT")) return { rows: [{ id: "user-id", email: "admin@example.com", account_type: "user" }] };
      insertCalled = true;
      return { rows: [] };
    },
  } as unknown as Pool;
  const inserted = await bootstrapLocalAdmin(pool, {
    NODE_ENV: "production",
    BDC_ADMIN_EMAIL: "admin@example.com",
    BDC_ADMIN_NAME: "Test Admin",
    BDC_ADMIN_PASSWORD_HASH: hash,
  });
  assert.equal(inserted, false);
  assert.equal(insertCalled, false);
});