import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { CONVERSATION_WORKFLOW_SQL, ensureConversationWorkflowColumns } from "@/features/contacts/infrastructure/persistence/postgres/conversation-workflow.migration";

test("conversation workflow schema supports dealer assignment and read state", async () => {
  assert.match(CONVERSATION_WORKFLOW_SQL, /assigned_user_id UUID/);
  assert.match(CONVERSATION_WORKFLOW_SQL, /read_at TIMESTAMPTZ DEFAULT now\(\)/);
  assert.match(CONVERSATION_WORKFLOW_SQL, /read_by_user_id UUID/);
  assert.match(CONVERSATION_WORKFLOW_SQL, /conversations_unread_idx/);
  let executed = "";
  await ensureConversationWorkflowColumns({ query: async (sql: string) => { executed = sql; return { rows: [] }; } } as unknown as Pool);
  assert.equal(executed, CONVERSATION_WORKFLOW_SQL);
});
