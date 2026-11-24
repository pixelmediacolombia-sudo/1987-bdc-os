import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { hashScryptPassword } from "@/features/identity/infrastructure/crypto/scrypt-password";
import { resolveDealerName } from "@/features/identity/dealer-name";
import { appendAudit, auditReference, tokenDigest, type IdentityRouteOptions, type Invitation, type IdentityUser } from "./route-helpers";

export function createInvitationRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const publicAppUrl = options.publicAppUrl ?? (options.production ? undefined : "http://localhost:3000");
  router.get("/invitations/accept", async (request: Request, response: Response) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      response.status(400).type("text/plain").send("El enlace de invitación no es válido.");
      return;
    }
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const loginUrl = publicAppUrl ? new URL("/", publicAppUrl).toString() : "/";
    const html = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activar cuenta | BDC OS</title><style>body{font:16px system-ui,sans-serif;background:#f5f5f3;color:#191919;margin:0;min-height:100vh;display:grid;place-items:center}.card{box-sizing:border-box;background:white;width:min(440px,calc(100% - 32px));padding:32px;border:1px solid #e4e3df;border-radius:16px}h1{font-size:26px;margin:0 0 8px}p{color:#666;line-height:1.5}label{display:block;font-size:14px;margin:20px 0 6px}input{box-sizing:border-box;width:100%;padding:13px;border:1px solid #d7d6d1;border-radius:8px;font:inherit}button{width:100%;margin-top:22px;padding:14px;background:#171717;color:white;border:0;border-radius:8px;font:600 15px system-ui;cursor:pointer}#message{min-height:24px;color:#9b3e26;font-size:14px}</style><main class="card"><h1>Activa tu cuenta</h1><p>Define una contraseña personal para acceder a BDC OS. Usa al menos 12 caracteres.</p><form id="accept"><label for="password">Contraseña</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required><label for="confirm">Confirma la contraseña</label><input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required><button>Crear cuenta</button><p id="message" role="status"></p></form></main><script>const token=${JSON.stringify(token)};const loginUrl=${JSON.stringify(loginUrl)};document.getElementById('accept').addEventListener('submit',async event=>{event.preventDefault();const password=document.getElementById('password').value;const confirm=document.getElementById('confirm').value;const message=document.getElementById('message');if(password!==confirm){message.textContent='Las contraseñas no coinciden.';return}message.textContent='Activando cuenta…';try{const response=await fetch('/auth/invitations/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,password})});const data=await response.json();message.textContent=response.ok?(data.existingAccount?'Dealer vinculado. Inicia sesión con tu contraseña habitual.':'Cuenta activada. Ya puedes iniciar sesión.'):(data.error||'No se pudo activar la cuenta.');if(response.ok)window.setTimeout(()=>window.location.assign(loginUrl),1000)}catch{message.textContent='No pudimos conectar con BDC OS.'}});</script></html>`;
    response.status(200).type("html").send(html);
  });

  router.post("/invitations/accept", async (request: Request, response: Response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token) || password.length < 12 || password.length > 1024) {
      response.status(400).json({ error: "El enlace o la contraseña no son válidos. Usa al menos 12 caracteres." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const invitation = await client.query<Omit<Invitation, "dealer_name">>(
        `SELECT i.id::text, i.tenant_id::text, i.email, i.display_name
           FROM public.dealer_invitations AS i
          WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          FOR UPDATE OF i`,
        [tokenDigest(token)],
      );
      const inviteDetails = invitation.rows[0];
      if (!inviteDetails) {
        await client.query("ROLLBACK");
        response.status(400).json({ error: "La invitación venció, ya se utilizó o fue revocada. Solicita otra al administrador." });
        return;
      }
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [inviteDetails.tenant_id]);
      const tenant = await client.query<{ dealer_name: string | null; ghl_location_id: string | null }>(
        "SELECT dealer_name, ghl_location_id FROM public.tenants WHERE dealer_id = $1 LIMIT 1", [inviteDetails.tenant_id],
      );
      if (!tenant.rows[0]) {
        await client.query("ROLLBACK");
        response.status(400).json({ error: "La invitación no corresponde a un dealer activo." });
        return;
      }
      const invite: Invitation = { ...inviteDetails, dealer_name: resolveDealerName(tenant.rows[0].dealer_name, tenant.rows[0].ghl_location_id) ?? "tu dealer" };
      const account = await client.query<{ id: string; account_type: string; status: string }>(
        "SELECT id::text, account_type, status FROM public.app_users WHERE lower(email) = $1 FOR UPDATE",
        [invite.email.toLowerCase()],
      );
      if (account.rows[0]?.account_type === "admin" || account.rows[0]?.status === "disabled") {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Esta cuenta requiere asistencia del administrador." });
        return;
      }
      let userId = account.rows[0]?.id;
      const existingAccount = Boolean(userId);
      if (!userId) {
        const passwordHash = await hashScryptPassword(password);
        const created = await client.query<{ id: string }>(
          `INSERT INTO public.app_users (email, display_name, password_hash, account_type, status)
           VALUES ($1, $2, $3, 'user', 'active') RETURNING id::text AS id`,
          [invite.email.toLowerCase(), invite.display_name, passwordHash],
        );
        userId = created.rows[0]?.id;
        if (!userId) throw new Error("User insert did not return an id");
      }
      await client.query(
        "INSERT INTO public.user_tenant_memberships (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [userId, invite.tenant_id],
      );
      await client.query("UPDATE public.dealer_invitations SET accepted_at = now() WHERE id = $1", [invite.id]);
      await appendAudit(client, { actor: { id: userId, email: invite.email, display_name: invite.display_name, account_type: "user" },
        dealerId: invite.tenant_id, dealerName: invite.dealer_name, category: "invitations", action: "invitation.accepted",
        summary: `Invitación aceptada por ${invite.email}; se activó su acceso al dealer.`, referenceId: auditReference(request) });
      await client.query("COMMIT");
      response.status(200).json({ activated: true, existingAccount, dealerName: invite.dealer_name });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      response.status(500).json({ error: "No pudimos activar la cuenta." });
    } finally {
      client.release();
    }
  });
  return router;
}
