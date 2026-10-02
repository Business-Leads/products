import { config } from "../config.js";
import { one, query } from "../db/index.js";
import type { CustomerRow } from "../engine/types.js";
import { hashPassword, hashToken } from "../lib/passwords.js";
import { token } from "../lib/util.js";
import { getProduct, products, type Product } from "../products/index.js";

export interface ClientUser {
  id: string;
  product: string;
  email: string;
  password_hash: string | null;
  disabled: boolean;
  failed_logins: number;
  locked_until: Date | null;
  created_at: Date;
  password_set_at: Date | null;
  last_login_at: Date | null;
}

export const SESSION_DAYS = 14;
const SETUP_DAYS = 14;
const RESET_HOURS = 2;

// ---------------------------------------------------------------- addresses

function domainsEnabled(slug: string): boolean {
  const list = config.portal.domains.split(",").map((s) => s.trim().toLowerCase());
  return list.includes("all") || list.includes(slug);
}

/** Public address of a product's account area, as clients should see it. */
export function portalUrl(product: Product): string {
  return domainsEnabled(product.slug) ? `https://${product.portal.host}` : `${config.baseUrl}/portal/${product.slug}`;
}

/** The product whose account area is served on this host, if any. */
export function productForHost(host: string | undefined): Product | undefined {
  const h = (host ?? "").split(":")[0]!.toLowerCase();
  return products.find((p) => p.portal.host === h);
}

// -------------------------------------------------------------------- users

export async function findUser(product: string, email: string): Promise<ClientUser | undefined> {
  return one<ClientUser>(`SELECT * FROM client_users WHERE product = $1 AND lower(email) = lower($2)`, [product, email.trim()]);
}

export async function getUser(id: string | number): Promise<ClientUser | undefined> {
  return one<ClientUser>(`SELECT * FROM client_users WHERE id = $1`, [id]);
}

/** The login for a customer, created (without a password) if it doesn't exist yet. */
export async function ensureClientUser(customer: Pick<CustomerRow, "product" | "email">): Promise<ClientUser> {
  await query(
    `INSERT INTO client_users (product, email) VALUES ($1, lower($2))
     ON CONFLICT (product, lower(email)) DO NOTHING`,
    [customer.product, customer.email.trim()],
  );
  return (await findUser(customer.product, customer.email))!;
}

/** All of a login's subscriptions, newest first. */
export async function customersFor(user: ClientUser): Promise<CustomerRow[]> {
  return query<CustomerRow>(
    `SELECT * FROM customers WHERE product = $1 AND lower(email) = lower($2) ORDER BY created_at DESC`,
    [user.product, user.email],
  );
}

export async function userForCustomer(customer: CustomerRow): Promise<ClientUser | undefined> {
  return findUser(customer.product, customer.email);
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await query(
    `UPDATE client_users SET password_hash = $2, password_set_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [userId, await hashPassword(password)],
  );
  // A new password signs out every other session.
  await query(`DELETE FROM client_sessions WHERE client_user_id = $1`, [userId]);
  await query(`UPDATE client_tokens SET used_at = now() WHERE client_user_id = $1 AND used_at IS NULL`, [userId]);
}

// ----------------------------------------------------------------- sessions

export async function createSession(userId: string): Promise<string> {
  const t = token(32);
  await query(
    `INSERT INTO client_sessions (token_hash, client_user_id, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
    [hashToken(t), userId, SESSION_DAYS],
  );
  await query(`UPDATE client_users SET last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`, [userId]);
  return t;
}

export async function userForSession(t: string | undefined, product: string): Promise<ClientUser | undefined> {
  if (!t) return undefined;
  return one<ClientUser>(
    `SELECT u.* FROM client_sessions s JOIN client_users u ON u.id = s.client_user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.product = $2 AND NOT u.disabled`,
    [hashToken(t), product],
  );
}

export async function endSession(t: string | undefined): Promise<void> {
  if (t) await query(`DELETE FROM client_sessions WHERE token_hash = $1`, [hashToken(t)]);
}

export async function endAllSessions(userId: string): Promise<void> {
  await query(`DELETE FROM client_sessions WHERE client_user_id = $1`, [userId]);
}

// ------------------------------------------------------------- link tokens

export async function createLinkToken(userId: string, purpose: "setup" | "reset"): Promise<string> {
  const t = token(32);
  const hours = purpose === "setup" ? SETUP_DAYS * 24 : RESET_HOURS;
  await query(
    `INSERT INTO client_tokens (token_hash, client_user_id, purpose, expires_at) VALUES ($1,$2,$3, now() + ($4 * interval '1 hour'))`,
    [hashToken(t), userId, purpose, hours],
  );
  return t;
}

export async function userForLinkToken(t: string, product: string): Promise<ClientUser | undefined> {
  return one<ClientUser>(
    `SELECT u.* FROM client_tokens k JOIN client_users u ON u.id = k.client_user_id
     WHERE k.token_hash = $1 AND k.used_at IS NULL AND k.expires_at > now() AND u.product = $2 AND NOT u.disabled`,
    [hashToken(t), product],
  );
}

/** Link to create a password for a new account (used in the welcome email). */
export async function setupLink(customer: CustomerRow): Promise<string> {
  const product = getProduct(customer.product)!;
  const user = await ensureClientUser(customer);
  if (user.password_hash) return `${portalUrl(product)}/login`;
  return `${portalUrl(product)}/password/${await createLinkToken(user.id, "setup")}`;
}

export async function resetLink(user: ClientUser): Promise<string> {
  const product = getProduct(user.product)!;
  return `${portalUrl(product)}/password/${await createLinkToken(user.id, "reset")}`;
}
