import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeBdcUser, accessibleDealers, loadBdcConversationMessages, loadBdcDashboard } from './bdc-live.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createDashboardRouter({ pool, publicDirectory, outboundSender }) {
  const router = express.Router();
  router.use((_request, response, next) => {
    response.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  router.use(express.json({ limit: '16kb' }));

  async function authorize(request, response) {
    const user = await activeBdcUser(pool, request);
    if (!user) {
      response.status(401).json({ error: 'authentication_required' });
      return null;
    }
    const requestedDealerId = request.query.dealerId || request.body?.dealerId;
    if (requestedDealerId && !UUID.test(String(requestedDealerId))) {
      response.status(400).json({ error: 'invalid_dealer' });
      return null;
    }
    const dealers = await accessibleDealers(pool, user, requestedDealerId ? String(requestedDealerId) : undefined);
    if (!dealers.length) {
      response.status(403).json({ error: 'dealer_access_denied' });
      return null;
    }
    return { user, dealers, dealer: dealers[0] };
  }

  router.get('/api/dashboard', async (request, response) => {
    try {
      const access = await authorize(request, response);
      if (!access) return;
      const dashboard = await loadBdcDashboard(pool, access.dealer.id);
      response.json({
        status: 'connected',
        updatedAt: dashboard.updatedAt,
        user: { id: access.user.id, name: access.user.name, role: access.user.role },
        dealers: access.dealers,
        selectedDealerId: access.dealer.id,
        dealer: dashboard.dealer,
        conversations: dashboard.conversations,
      });
    } catch {
      response.status(503).json({ error: 'dashboard_unavailable' });
    }
  });

  router.get('/api/conversations/:conversationId/messages', async (request, response) => {
    try {
      const access = await authorize(request, response);
      if (!access) return;
      if (!UUID.test(request.params.conversationId)) return response.status(400).json({ error: 'invalid_conversation' });
      const messages = await loadBdcConversationMessages(pool, access.dealer.id, request.params.conversationId);
      response.json({ messages });
    } catch {
      response.status(503).json({ error: 'conversation_unavailable' });
    }
  });

  router.post('/api/conversations/:conversationId/messages', async (request, response) => {
    try {
      const origin = request.get('origin');
      if (origin && new URL(origin).host !== request.get('host')) return response.status(403).json({ error: 'origin' });
      const access = await authorize(request, response);
      if (!access) return;
      if (!outboundSender) return response.status(503).json({ error: 'messaging_not_configured' });
      if (!UUID.test(request.params.conversationId)) return response.status(400).json({ error: 'invalid_conversation' });
      const content = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
      if (!content || content.length > 4000) return response.status(400).json({ error: 'invalid_message' });
      const client = await pool.connect();
      let message;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [access.dealer.id]);
        const result = await client.query(
          `SELECT contact.provider_contact_id AS contact_id, conversation.channel
             FROM public.conversations conversation
             JOIN public.contacts contact ON contact.id = conversation.contact_id
            WHERE conversation.tenant_id = $1 AND conversation.id = $2
            LIMIT 1`,
          [access.dealer.id, request.params.conversationId],
        );
        message = result.rows[0];
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (!message) return response.status(404).json({ error: 'conversation_not_found' });
      const channels = { messenger: 'FB', facebook: 'FB', fb: 'FB', instagram: 'IG', ig: 'IG', whatsapp: 'WhatsApp' };
      const channel = channels[String(message.channel).toLowerCase()];
      if (!channel) return response.status(422).json({ error: 'unsupported_channel' });
      const delivered = await outboundSender.send({
        tenantId: access.dealer.id,
        contactId: message.contact_id,
        channel,
        content,
        externalId: randomUUID(),
      });
      response.status(202).json({ queued: true, providerMessageId: delivered.providerMessageId });
    } catch {
      response.status(502).json({ error: 'message_delivery_failed' });
    }
  });

  router.use(express.static(publicDirectory, { index: 'index.html', setHeaders: response => response.set('Cache-Control', 'private, no-store') }));
  router.get('/', (_request, response) => response.sendFile(path.join(publicDirectory, 'index.html')));
  return router;
}
