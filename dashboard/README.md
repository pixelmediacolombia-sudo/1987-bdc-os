# Lucki embedded dashboard

Reuses the approved navy/mint UI and read-only GHL adapters from the owner-private Site. Served at `/mi-dia/` on the existing backend. No call, message, task-write or workflow-enrollment endpoints are added.

`GHL_APP_SHARED_SECRET` decrypts the official app-specific GHL context. Only Johanna's fixed user ID in Lucki and the verified agency owner may obtain a 30-minute in-memory bearer session. URL parameters and caller-supplied user IDs do not grant access. The browser holds no GHL/API credential and needs no ChatGPT login. Cross-site cookies are not required. Restarting the service invalidates dashboard sessions.

`BDC_GHL_READ_TOKEN` must be the existing subaccount-only read integration with contacts, users, tasks and conversation/message read scopes. Never reuse a broader write credential. AI uses `BDC_OPENAI_API_KEY`, falling back to the owner's existing `CONVERSATIONAL_MODEL_API_KEY`; no agent key is needed. AI context is isolated in `public.lucki_bdc_dashboard_briefs`, with the same seven-day cache/lease logic as the Site. No old tables or automation flags are changed.

Build: `npm install --prefix dashboard && npm run build --prefix dashboard`. The tested generated files in `compiled/` and `public/` are copied into the backend Docker image. Source and generated assets contain no secrets.

The existing GHL app must load `https://bdc.1987marketing.com/mi-dia/bridge.js` as Custom JS. The bridge is limited to the exact Lucki path and actual dashboard iframe, and calls the documented `exposeSessionDetails(APP_ID)` method. On initial Launchpad/default-Dashboard entry, a server-validated Johanna session navigates to the exact MI DÍA dashboard. Other users keep their existing landing screen; the account-wide default is unchanged. Use a direct external URL embed: the observed native HTML widget has an empty sandbox and does not execute scripts. A live app module requires its normal draft/version publication process. No app module, version or default-dashboard change has been published by these source changes.

Native dashboard embedding and signed-context availability must be verified in the actual GHL screen before claiming installation complete. Default-dashboard settings affect the subaccount, not just Johanna. No existing dashboard access is broadened automatically.

Checks: `node --test dashboard/server/access.test.mjs`; backend `npm run typecheck` and existing security regression tests. Any inability to authenticate or read sources fails closed and never substitutes demo data as live data.
