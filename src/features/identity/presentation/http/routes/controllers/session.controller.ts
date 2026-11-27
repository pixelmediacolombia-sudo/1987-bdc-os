import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { hashScryptPassword, verifyScryptPassword } from "@/features/identity/infrastructure/crypto/scrypt-password";
import { activeSession, cookieValue, failedAttempts, failureKey, recordFailure, rateLimited, SESSION_TTL_SECONDS, sessionCookie, tokenDigest, type IdentityRouteOptions, type IdentityUser } from "../route-helpers";



export class SessionController {
  constructor(private readonly pool: Pool, private readonly options: IdentityRouteOptions) {}

  async createLogin(request: Request, response: Response): Promise<void> {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!email || !password || email.length > 254 || password.length > 1024) {
      response.status(400).json({ error: "Ingresa un correo y una contraseña válidos." });
      return;
    }
    if (rateLimited(request, email)) {
      response.status(429).json({ error: "Demasiados intentos. Espera unos minutos y vuelve a probar." });
      return;
    }

    try {
      const result = await this.pool.query<IdentityUser & { password_hash: string | null; status: string }>(
        `SELECT id::text, email, display_name, account_type, password_hash, status
           FROM public.app_users
          WHERE lower(email) = $1
          LIMIT 1`,
        [email],
      );
      const user = result.rows[0];
      const passwordMatches = user?.status === "active" && user.password_hash
        ? await verifyScryptPassword(password, user.password_hash)
        : false;
      if (!user || !passwordMatches) {
        recordFailure(request, email);
        response.status(401).json({ error: "Correo o contraseña incorrectos." });
        return;
      }

      failedAttempts.delete(failureKey(request, email));
      const token = randomBytes(32).toString("base64url");
      await this.pool.query(
        `INSERT INTO public.app_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
        [user.id, tokenDigest(token), SESSION_TTL_SECONDS],
      );
      response.setHeader("Set-Cookie", sessionCookie(token, this.options.production));
      response.status(200).json({
        authenticated: true,
        user: { id: user.id, email: user.email, displayName: user.display_name, accountType: user.account_type },
      });
    } catch {
      response.status(500).json({ error: "No pudimos iniciar sesión. Inténtalo de nuevo." });
    }
  }

  async getSession(request: Request, response: Response): Promise<void> {
    try {
      const user = await activeSession(this.pool, request);
      if (!user) {
        response.setHeader("Set-Cookie", sessionCookie(undefined, this.options.production));
        response.status(401).json({ authenticated: false });
        return;
      }
      response.status(200).json({
        authenticated: true,
        user: { id: user.id, email: user.email, displayName: user.display_name, accountType: user.account_type },
      });
    } catch {
      response.status(500).json({ error: "No pudimos verificar la sesión." });
    }
  }

  async createLogout(request: Request, response: Response): Promise<void> {
    const token = cookieValue(request);
    try {
      if (token && token.length <= 256) {
        await this.pool.query(
          "UPDATE public.app_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
          [tokenDigest(token)],
        );
      }
      response.setHeader("Set-Cookie", sessionCookie(undefined, this.options.production));
      response.status(200).json({ authenticated: false });
    } catch {
      response.status(500).json({ error: "No pudimos cerrar la sesión." });
    }
  }
}
