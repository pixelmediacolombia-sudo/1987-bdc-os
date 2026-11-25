import type { Pool } from "pg";

export const CONVERSATION_WORKFLOW_SQL = `
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS assigned_user_id UUID;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS read_by_user_id UUID;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_assigned_user_fk') THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_assigned_user_fk
      FOREIGN KEY (assigned_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_read_by_user_fk') THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_read_by_user_fk
      FOREIGN KEY (read_by_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS conversations_assignee_idx
  ON public.conversations (tenant_id, assigned_user_id, last_activity DESC)
  WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_unread_idx
  ON public.conversations (tenant_id, last_activity DESC)
  WHERE read_at IS NULL;
`;

export async function ensureConversationWorkflowColumns(pool: Pool): Promise<void> {
  await pool.query(CONVERSATION_WORKFLOW_SQL);
}
