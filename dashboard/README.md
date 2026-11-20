# BDC OS conversations dashboard

Served at `/mi-dia/` by the existing backend. The dashboard reads dealer-scoped conversations, messages and Sofia qualification state from PostgreSQL and supports text replies through each dealer's Meta connection for Messenger, Instagram and WhatsApp. Calls are outside this panel's scope.

Requests require the standard revocable BDC OS session cookie. Dealer accounts can access only dealers in `user_tenant_memberships`; the global admin can select a dealer. Every conversation/message query sets `app.tenant_id` in a PostgreSQL transaction. Outbound messages use the registered sender and the connected dealer's Meta credentials.

No calls, external CRM tokens, embedded-user identity or per-agent credentials are required. Sofia lead evaluation and the existing OpenAI integration remain in the backend conversation pipeline.

Build: `npm install --prefix dashboard && npm run build --prefix dashboard`. Docker builds the dashboard bundle and copies it into the backend image. Source and generated assets contain no secrets.

Checks: build the dashboard, run the backend security/integration suites, and verify `/mi-dia/api/dashboard` with an authenticated BDC OS session against local PostgreSQL. Unauthorized sessions fail closed.
