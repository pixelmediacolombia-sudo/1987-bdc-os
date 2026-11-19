import assert from "node:assert/strict";
import { once } from "node:events";
import { scryptSync, randomBytes } from "node:crypto";
import express from "express";
import test from "node:test";
import type { Pool } from "pg";
import { verifyScryptPassword } from "@/features/identity/infrastructure/crypto/scrypt-password";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";

const email = "admin@bdc-os.local";
const password = "local-test-password-44";
const salt = randomBytes(16);
const passwordHash = `scrypt$32768$8$1$${salt.toString("base64url")}$${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")}`;

test("scrypt verifier accepts the matching password and rejects wrong or malformed values", async () => {
  assert.equal(await verifyScryptPassword(password, passwordHash), true);
  assert.equal(await verifyScryptPassword("wrong-password", passwordHash), false);
  assert.equal(await verifyScryptPassword(password, "plaintext-password"), false);
});

test("identity HTTP flow logs in, persists only a token digest, checks session, and revokes logout", async (context) => {
  let storedTokenHash = "";
  let revoked = false;
  const user = { id: "admin-id", email, display_name: "Local Admin", account_type: "admin" as const };
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM public.app_users")) {
        return { rows: values[0] === email ? [{ ...user, password_hash: passwordHash, status: "active" }] : [] };
      }
      if (sql.includes("INSERT INTO public.app_sessions")) {
        storedTokenHash = String(values[1]);
        return { rows: [] };
      }
      if (sql.includes("FROM public.app_sessions")) {
        return { rows: !revoked && values[0] === storedTokenHash ? [user] : [] };
      }
      if (sql.includes("UPDATE public.app_sessions")) {
        revoked = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in identity route test: ${sql.slice(0, 40)}`);
    },
  } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/auth`;

  const rejected = await fetch(`${baseUrl}/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "wrong" }),
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("set-cookie"), null);

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie ?? "", /^bdc_os_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
  assert.ok(storedTokenHash.length === 64);
  assert.doesNotMatch(cookie ?? "", new RegExp(storedTokenHash));

  const session = await fetch(`${baseUrl}/session`, { headers: { cookie: cookie!.split(";")[0]! } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    authenticated: true,
    user: { id: user.id, email, displayName: user.display_name, accountType: "admin" },
  });

  const logout = await fetch(`${baseUrl}/logout`, { method: "POST", headers: { cookie: cookie!.split(";")[0]! } });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/session`, { headers: { cookie: cookie!.split(";")[0]! } });
  assert.equal(afterLogout.status, 401);
});

test("production identity cookies are Secure", async (context) => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use("/auth", createIdentityRouter(pool, { production: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/auth/session`);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("set-cookie") ?? "", /; Secure/);
});
