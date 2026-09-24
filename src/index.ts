import { assertProductionConfig, config, isProduction } from "./config.js";
import { pool } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { startScheduler, stopScheduler } from "./engine/scheduler.js";
import { buildServer } from "./web/server.js";

async function main() {
  const problems = assertProductionConfig();
  if (isProduction && problems.length) {
    throw new Error(`Refusing to start: ${problems.join("; ")}`);
  }
  const applied = await migrate();
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

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
