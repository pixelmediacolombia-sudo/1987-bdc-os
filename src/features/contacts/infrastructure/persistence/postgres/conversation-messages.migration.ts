import type { Pool } from "pg";

export async function ensureConversationMessageDelivery(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE public.messages
      ADD COLUMN IF NOT EXISTS client_message_id UUID,
      ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS messages_client_idempotency_uq
      ON public.messages (tenant_id, conversation_id, client_message_id)
      WHERE client_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_conversation_order_idx
      ON public.messages (tenant_id, conversation_id, created_at, id);
  `);
}
