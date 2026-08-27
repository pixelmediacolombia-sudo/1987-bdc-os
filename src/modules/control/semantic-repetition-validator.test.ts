import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { SemanticRepetitionValidator } from "@/modules/control/application/SemanticRepetitionValidator";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_UUID = "22222222-2222-4222-8222-222222222222";
const GHL_CONTACT_ID = "UMOLUbG99FINpmak6wvw";

test("resuelve el GHL contact ID antes de consultar columnas UUID", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("FROM public.contacts")) return { rows: [{ id: CONTACT_UUID }] };
      if (sql.includes("FROM public.messages")) return { rows: [] };
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;

  const result = await new SemanticRepetitionValidator(pool).validate({
    tenantId: TENANT_ID,
    contactId: GHL_CONTACT_ID,
    content: "Hola busco un SUV",
  });

  assert.equal(result.accepted, true);
  const messageQuery = calls.find((call) => call.sql.includes("FROM public.messages"));
  assert.equal(messageQuery?.values?.[0], TENANT_ID);
  assert.equal(messageQuery?.values?.[1], CONTACT_UUID);
  assert.notEqual(messageQuery?.values?.[1], GHL_CONTACT_ID);
  assert.match(messageQuery?.sql ?? "", /previous_inbound\.created_at/);
});
