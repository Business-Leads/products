import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { query, one } from "../db/index.js";

const KEYLEN = 64;
const COST = 16384;

function scryptAsync(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "That password is too long.";
  if (confirm !== undefined && password !== confirm) return "The two passwords don't match.";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, COST);
  return `scrypt$${COST}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") {
    // Spend the same time as a real check so missing accounts can't be detected by timing.
    await scryptAsync(password, randomBytes(16), COST);
    return false;
  }
  const key = await scryptAsync(password, Buffer.from(parts[2]!, "base64"), Number(parts[1]));
  const expected = Buffer.from(parts[3]!, "base64");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Session and link tokens are stored only as hashes. */
export function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

// ------------------------------------------------------------ throttling

/** Failed sign-ins allowed per scope (e.g. per IP address) in the window. */
const WINDOW_MINUTES = 15;

export async function tooManyFailures(scope: string, limit: number): Promise<boolean> {
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM login_failures WHERE scope = $1 AND at > now() - ($2 * interval '1 minute')`,
    [scope, WINDOW_MINUTES],
  );
  return (row?.n ?? 0) >= limit;
}

export async function recordFailure(scope: string): Promise<void> {
  await query(`INSERT INTO login_failures (scope) VALUES ($1)`, [scope]);
}

export async function clearFailures(scope: string): Promise<void> {
  await query(`DELETE FROM login_failures WHERE scope = $1`, [scope]);
}

export async function pruneFailures(): Promise<void> {
  await query(`DELETE FROM login_failures WHERE at < now() - interval '1 day'`);
}
