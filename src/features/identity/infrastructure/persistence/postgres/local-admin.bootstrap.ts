import type { Pool } from "pg";

export type LocalAdminEnvironment = {
  NODE_ENV?: string;
  BDC_ADMIN_EMAIL?: string;
  BDC_ADMIN_NAME?: string;
  BDC_ADMIN_PASSWORD_HASH?: string;
};

const SCRYPT_HASH_PATTERN = /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{20,}\$[A-Za-z0-9_-]{40,}$/;

export async function bootstrapLocalAdmin(
  pool: Pool,
  environment: LocalAdminEnvironment = process.env,
): Promise<boolean> {
  const configured = [
    environment.BDC_ADMIN_EMAIL,
    environment.BDC_ADMIN_NAME,
    environment.BDC_ADMIN_PASSWORD_HASH,
  ];

  if (configured.every((value) => !value)) return false;
  const nodeEnvironment = environment.NODE_ENV;
  if (nodeEnvironment !== "development" && nodeEnvironment !== "production") {
    throw new Error("BDC OS admin bootstrap is allowed only when NODE_ENV=development or production");
  }
  if (configured.some((value) => !value?.trim())) {
    throw new Error("BDC_ADMIN_EMAIL, BDC_ADMIN_NAME, and BDC_ADMIN_PASSWORD_HASH must all be set");
  }

  const email = environment.BDC_ADMIN_EMAIL!.trim().toLowerCase();
  const displayName = environment.BDC_ADMIN_NAME!.trim();
  const passwordHash = environment.BDC_ADMIN_PASSWORD_HASH!.trim().replace(/\$\$/g, "$");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("BDC_ADMIN_EMAIL must be a valid email address");
  }
  if (!SCRYPT_HASH_PATTERN.test(passwordHash)) {
    throw new Error("BDC_ADMIN_PASSWORD_HASH must be a scrypt hash using N=32768, r=8, and p=1");
  }

  const existing = await pool.query<{ id: string; email: string; account_type: "admin" | "user" }>(
    "SELECT id::text, email, account_type " +
      "FROM public.app_users " +
      "WHERE lower(email) = $1 OR account_type = 'admin' " +
      "LIMIT 2",
    [email],
  );
  const configuredAccount = existing.rows.find((row) => row.email.toLowerCase() === email);
  if (configuredAccount) {
    if (configuredAccount.account_type === "admin") return false;
    if (nodeEnvironment === "production") {
      console.warn("[Identity] admin bootstrap skipped because the configured account is not an admin");
      return false;
    }
    throw new Error("A user already exists locally with the configured admin email");
  }

  const existingAdmin = existing.rows.find((row) => row.account_type === "admin");
  if (existingAdmin) {
    if (nodeEnvironment === "production") {
      console.warn("[Identity] admin bootstrap skipped because a platform admin already exists");
      return false;
    }
    throw new Error("A platform admin already exists locally with a different email");
  }

  await pool.query(
    "INSERT INTO public.app_users (email, display_name, password_hash, account_type, status) " +
      "VALUES ($1, $2, $3, 'admin', 'active')",
    [email, displayName, passwordHash],
  );
  return true;
}