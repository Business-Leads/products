import { assertProductionConfig, config, isProduction } from "./config.js";
import { pool } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { startScheduler, stopScheduler } from "./engine/scheduler.js";
import { buildServer } from "./web/server.js";
import { sendPendingInvites } from "./web/team.js";

async function main() {
  const problems = assertProductionConfig();
  if (isProduction && problems.length) {
    throw new Error(`Refusing to start: ${problems.join("; ")}`);
  }
  const applied = await migrate();
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  // Which database HQ is using (host, names and counts only), so backups know where to look.
  try {
    const url = new URL(config.databaseUrl);
    const where = await pool.query(
      `SELECT current_database() AS database, current_user AS "user", inet_server_addr()::text AS server,
              pg_postmaster_start_time()::text AS server_started, current_schema() AS schema,
              (SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema())::int AS tables,
              (SELECT count(*) FROM schema_migrations)::int AS migrations`,
    );
    console.log(`HQ database: ${JSON.stringify({ host: url.hostname, port: url.port, ...where.rows[0] })}`);
  } catch (err) {
    console.log(`HQ database: couldn't describe it (${(err as Error).message})`);
  }
  const invited = await sendPendingInvites().catch((err) => (console.error("HQ invites:", err), 0));
  if (invited) console.log(`Emailed ${invited} HQ login link(s)`);

  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  startScheduler();

  const shutdown = async () => {
    stopScheduler();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
