import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, scryptSync, randomBytes } from "node:crypto";
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

test("admin creates an inert dealer and one-time invitation; invitee chooses a hashed password", async (context) => {
  const sessionToken = "admin-browser-session";
  const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
  const admin = { id: "admin-id", email, display_name: "Local Admin", account_type: "admin" as const };
  let createdDealerId = "";
  let invitationDigest = "";
  let createdPasswordHash = "";
  let invitationAccepted = false;
  const auditEvents: unknown[][] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("set_config('app.tenant_id'")) { createdDealerId = String(values[0]); return { rows: [] }; }
      if (sql.includes("INSERT INTO public.admin_audit_events")) { auditEvents.push(values); return { rows: [] }; }
      if (sql.includes("FROM public.app_users WHERE lower(email) = $1")) return { rows: [] };
      if (sql.includes("INSERT INTO public.tenants")) {
        assert.equal(values[1], "Sample Dealer");
        assert.match(sql, /VALUES \(\$1, \$2/);
        assert.match(sql, /false, false, false/);
        assert.equal(values[0], createdDealerId);
        return { rows: [{ id: createdDealerId }] };
      }
      if (sql.includes("INSERT INTO public.dealer_invitations")) {
        invitationDigest = String(values[3]);
        return { rows: [] };
      }
      if (sql.includes("SELECT i.id::text")) {
        assert.equal(values[0], invitationDigest);
        return { rows: invitationAccepted ? [] : [{
          id: "invite-1", tenant_id: createdDealerId, email: "owner@example.com", display_name: "Dealer Owner", dealer_name: "Sample Dealer",
        }] };
      }
      if (sql.includes("SELECT dealer_name FROM public.tenants")) return { rows: [{ dealer_name: "Sample Dealer" }] };
      if (sql.includes("SELECT id::text, account_type, status FROM public.app_users")) return { rows: [] };
      if (sql.includes("INSERT INTO public.app_users")) {
        createdPasswordHash = String(values[2]);
        return { rows: [{ id: "owner-id" }] };
      }
      if (sql.includes("INSERT INTO public.user_tenant_memberships")) {
        assert.deepEqual(values, ["owner-id", createdDealerId]);
        return { rows: [] };
      }
      if (sql.includes("UPDATE public.dealer_invitations SET accepted_at")) {
        invitationAccepted = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected identity invitation SQL: ${sql.slice(0, 80)}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM public.app_sessions")) return { rows: values[0] === sessionHash ? [admin] : [] };
      throw new Error(`Unexpected identity pool SQL: ${sql.slice(0, 80)}`);
    },
    connect: async () => client,
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
  const cookie = `bdc_os_session=${sessionToken}`;

  const created = await fetch(`${baseUrl}/admin/dealers`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ dealerName: "Sample Dealer", ownerName: "Dealer Owner", ownerEmail: "Owner@Example.com" }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { dealer: { id: string; status: string }; invitation: { url: string; expiresInHours: number } };
  assert.equal(createdBody.dealer.id, createdDealerId);
  assert.equal(createdBody.dealer.status, "onboarding");
  assert.equal(createdBody.invitation.expiresInHours, 72);
  const inviteUrl = new URL(createdBody.invitation.url);
  assert.equal(inviteUrl.origin, "http://localhost:3000");
  const rawToken = inviteUrl.searchParams.get("token");
  assert.ok(rawToken);
  assert.notEqual(invitationDigest, rawToken);
  assert.equal(invitationDigest, createHash("sha256").update(rawToken).digest("hex"));

  const page = await fetch(`${baseUrl}/invitations/accept?token=${encodeURIComponent(rawToken)}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const activationHtml = await page.text();
  assert.match(activationHtml, /Cuenta activada\. Ya puedes iniciar sesión\./);
  assert.match(activationHtml, /window\.setTimeout\(\(\)=>window\.location\.assign\(loginUrl\),1000\)/);
  assert.match(activationHtml, /const loginUrl="http:\/\/localhost:3000\/"/);

  const accepted = await fetch(`${baseUrl}/invitations/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: rawToken, password: "dealer-password-long-enough" }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { activated: true, existingAccount: false, dealerName: "Sample Dealer" });
  assert.match(createdPasswordHash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyScryptPassword("dealer-password-long-enough", createdPasswordHash), true);
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents[0]?.[6], "dealer.created");
  assert.equal(auditEvents[1]?.[6], "invitation.accepted");
  assert.ok(auditEvents.every((event) => !String(event).includes(rawToken)));

  const reused = await fetch(`${baseUrl}/invitations/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: rawToken, password: "dealer-password-long-enough" }),
  });
  assert.equal(reused.status, 400);
});

test("a dealer user cannot create a dealer invitation", async (context) => {
  const sessionToken = "dealer-browser-session";
  const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
  const user = { id: "user-id", email: "dealer@example.com", display_name: "Dealer", account_type: "user" as const };
  const pool = { query: async (_sql: string, values: unknown[] = []) => ({ rows: values[0] === sessionHash ? [user] : [] }) } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/auth/admin/dealers`, {
    method: "POST", headers: { cookie: `bdc_os_session=${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ dealerName: "Other Dealer", ownerName: "Owner", ownerEmail: "owner@example.com" }),
  });
  assert.equal(response.status, 403);
});

test("only an admin can delete a dealer and the handler reports missing dealers", async (context) => {
  const sessionToken = "admin-delete-session";
  const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
  const dealerToken = "dealer-delete-session";
  const dealerHash = createHash("sha256").update(dealerToken).digest("hex");
  const admin = { id: "admin-id", email, display_name: "Local Admin", account_type: "admin" as const };
  const dealerUser = { id: "dealer-id", email: "dealer@example.com", display_name: "Dealer User", account_type: "user" as const };
  const deleted: string[] = [];
  const auditEvents: unknown[][] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("set_config('app.tenant_id'")) return { rows: [] };
      if (sql.includes("SELECT dealer_name FROM public.tenants")) return values[0] === "11111111-1111-4111-8111-111111111113" ? { rows: [] } : { rows: [{ dealer_name: "Delete Test Dealer" }] };
      if (sql.includes("DELETE FROM public.tenants")) { deleted.push(String(values[0])); return { rows: [] }; }
      if (sql.includes("INSERT INTO public.admin_audit_events")) { auditEvents.push(values); return { rows: [] }; }
      throw new Error(`Unexpected identity delete SQL: ${sql.slice(0, 80)}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM public.app_sessions")) return { rows: values[0] === sessionHash ? [admin] : values[0] === dealerHash ? [dealerUser] : [] };
      throw new Error(`Unexpected identity pool SQL: ${sql.slice(0, 80)}`);
    },
    connect: async () => client,
  } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/auth/admin/dealers`;
  const cookie = `bdc_os_session=${sessionToken}`;

  const removed = await fetch(`${baseUrl}/11111111-1111-4111-8111-111111111111`, { method: "DELETE", headers: { cookie } });
  assert.equal(removed.status, 204);
  assert.deepEqual(deleted, ["11111111-1111-4111-8111-111111111111"]);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.[6], "dealer.deleted");
  assert.equal(auditEvents[0]?.[4], "Delete Test Dealer");

  const denied = await fetch(`${baseUrl}/11111111-1111-4111-8111-111111111112`, { method: "DELETE", headers: { cookie: `bdc_os_session=${dealerToken}` } });
  assert.equal(denied.status, 403);
  assert.deepEqual(deleted, ["11111111-1111-4111-8111-111111111111"]);

  const missing = await fetch(`${baseUrl}/11111111-1111-4111-8111-111111111113`, { method: "DELETE", headers: { cookie } });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "No encontramos ese dealer." });

  const invalid = await fetch(`${baseUrl}/missing-dealer`, { method: "DELETE", headers: { cookie } });
  assert.equal(invalid.status, 400);
});
