import { createHash } from 'node:crypto';

const COOKIE = 'bdc_os_session';

function sessionToken(request) {
  const value = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
  if (!value) return null;
  try { return decodeURIComponent(value.slice(COOKIE.length + 1)); } catch { return null; }
}

export async function activeBdcUser(pool, request) {
  const token = sessionToken(request);
  if (!token || token.length > 256) return null;
  const result = await pool.query(
    `SELECT u.id::text AS id, u.email, u.display_name AS name, u.account_type AS role
       FROM public.app_sessions s
       JOIN public.app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL
        AND s.expires_at > now() AND u.status = 'active'
      LIMIT 1`,
    [createHash('sha256').update(token).digest('hex')],
  );
  return result.rows[0] ?? null;
}

export async function accessibleDealers(pool, user, requestedDealerId) {
  const result = user.role === 'admin'
    ? await pool.query(
        `SELECT dealer_id::text AS id, dealer_name AS name
           FROM public.tenants
          WHERE ($1::uuid IS NULL OR dealer_id = $1::uuid)
          ORDER BY dealer_name`,
        [requestedDealerId || null],
      )
    : await pool.query(
        `SELECT t.dealer_id::text AS id, t.dealer_name AS name
           FROM public.user_tenant_memberships m
           JOIN public.tenants t ON t.dealer_id = m.tenant_id
          WHERE m.user_id = $1 AND ($2::uuid IS NULL OR t.dealer_id = $2::uuid)
          ORDER BY t.dealer_name`,
        [user.id, requestedDealerId || null],
      );
  return result.rows;
}

export async function loadBdcDashboard(pool, dealerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
    const [dealer, conversations] = await Promise.all([
      client.query(`SELECT dealer_id::text AS id, dealer_name AS name FROM public.tenants WHERE dealer_id = $1 LIMIT 1`, [dealerId]),
      client.query(
        `SELECT conversation.id::text AS id,
                contact.id::text AS contact_id,
                contact.phone,
                contact.email,
                conversation.channel,
                conversation.state,
                conversation.last_activity,
                latest.content AS preview,
                latest.direction,
                latest.created_at AS last_message_at,
                COALESCE(qualification.lead_level, 'C') AS lead_level,
                COALESCE(qualification.fields, '{}'::jsonb) AS qualification
           FROM public.conversations conversation
           JOIN public.contacts contact ON contact.id = conversation.contact_id
           LEFT JOIN LATERAL (
             SELECT message.content, message.direction, message.created_at
               FROM public.messages message
              WHERE message.conversation_id = conversation.id
                AND message.tenant_id = conversation.tenant_id
              ORDER BY message.created_at DESC
              LIMIT 1
           ) latest ON true
           LEFT JOIN public.sofia_conversation_state qualification
             ON qualification.tenant_id = conversation.tenant_id
            AND qualification.contact_id = contact.id
          WHERE conversation.tenant_id = $1
          ORDER BY COALESCE(latest.created_at, conversation.last_activity) DESC
          LIMIT 250`,
        [dealerId],
      ),
    ]);
    await client.query('COMMIT');
    return {
      dealer: dealer.rows[0] ?? null,
      updatedAt: new Date().toISOString(),
      conversations: conversations.rows.map(row => ({
        id: row.id,
        contactId: row.contact_id,
        name: row.qualification?.contact_name || row.email || row.phone || 'Contacto',
        phone: row.phone,
        channel: row.channel,
        state: row.state,
        preview: row.preview || 'Sin mensajes',
        direction: row.direction || null,
        lastMessageAt: row.last_message_at,
        leadLevel: row.lead_level,
        qualification: row.qualification,
      })),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadBdcConversationMessages(pool, dealerId, conversationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
    const result = await client.query(
      `SELECT message.id::text AS id, message.direction, message.sender_type,
              message.content, message.created_at
         FROM public.messages message
         JOIN public.conversations conversation ON conversation.id = message.conversation_id
        WHERE conversation.tenant_id = $1 AND conversation.id = $2
        ORDER BY message.created_at DESC
        LIMIT 50`,
      [dealerId, conversationId],
    );
    await client.query('COMMIT');
    return result.rows.reverse();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
