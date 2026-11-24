import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import type { MetaOAuthClient } from "@/features/meta/application/oauth/meta-oauth.client";
import type { OAuthStateService } from "@/features/meta/application/oauth/oauth-state.port";
import type { PostgresMetaMessagingConnectionRepository } from "@/features/meta/infrastructure/persistence/postgres/postgres-meta-messaging-connection.repository";
import { MetaOAuthController } from "./meta-oauth.controller";

test("Meta OAuth tenant reads and updates use the transaction-local RLS context", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const clients: PoolClient[] = [];
  const pool = {
    connect: async () => {
      const client = {
        query: async (sql: string, values: unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("FROM public.tenants")) return { rows: [{ facebook_page_id: null }] };
          return { rows: [] };
        },
        release: () => undefined,
      } as unknown as PoolClient;
      clients.push(client);
      return client;
    },
  };
  const state = { verify: () => ({ tenantId, issuedAt: Date.now(), nonce: "nonce" }) } as unknown as OAuthStateService;
  const oauth = {
    exchangeCode: async () => ({ accessToken: "short-lived" }),
    exchangeLongLivedToken: async () => ({ accessToken: "long-lived" }),
    listAssets: async () => ({ pages: [{ id: "page-1", name: "Test Page", accessToken: "page-token" }], whatsappPhoneNumberIds: [], grantedScopes: ["pages_messaging"] }),
  } as unknown as MetaOAuthClient;
  const saved: unknown[] = [];
  const connections = { save: async (input: unknown) => { saved.push(input); } } as unknown as PostgresMetaMessagingConnectionRepository;
  const controller = new MetaOAuthController(pool as never, state, oauth, connections, "https://app.example.com/oauth/meta/callback", "https://app.example.com");
  let redirect: { status: number; url: string } | undefined;
  const response = {
    status: () => response,
    json: () => response,
    redirect: (status: number, url: string) => { redirect = { status, url }; return response; },
  } as unknown as Response;
  const request = { query: { code: "one-time-code", state: "signed-state" } } as unknown as Request;

  await controller.callback(request, response);

  assert.equal(clients.length, 2);
  assert.equal(saved.length, 1);
  assert.equal(redirect?.status, 303);
  assert.match(redirect?.url ?? "", /meta_connection=connected/);
  assert.equal(calls.filter(({ sql }) => sql.includes("set_config('app.tenant_id'" )).length, 2);
  for (const tenantQuery of calls.filter(({ sql }) => sql.includes("FROM public.tenants") || sql.startsWith("UPDATE public.tenants"))) {
    const index = calls.indexOf(tenantQuery);
    const prior = calls.slice(0, index).filter(({ sql }) => sql.includes("set_config('app.tenant_id'"));
    assert.equal(prior.at(-1)?.values[0], tenantId);
  }
});
