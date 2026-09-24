import pg from "pg";
import { config } from "../config.js";

// DigitalOcean managed Postgres requires TLS; DATABASE_CA_CERT (the cluster's CA,
// injected by App Platform as ${db.CA_CERT}) lets us verify it properly.
const ca = process.env.DATABASE_CA_CERT?.trim();

export const pool = new pg.Pool({
  connectionString: ca ? config.databaseUrl.replace(/[?&]sslmode=[^&]*/, "") : config.databaseUrl,
  ssl: ca ? { ca } : config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
