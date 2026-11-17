import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DAY_MS } from "./db.js";

const TRIM_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  const trim = setInterval(() => {
    const removed = app.repo.trimChecks(Date.now() - config.rawRetentionDays * DAY_MS);
    if (removed > 0) app.log.info({ removed }, "trimmed raw checks");
  }, TRIM_INTERVAL_MS);
  trim.unref();

  const sweep = setInterval(() => {
    try {
      const changed = app.sweep();
      if (changed > 0) app.log.info({ changed }, "status changed after a region went silent");
    } catch (err) {
      app.log.error({ err }, "sweep failed");
    }
  }, config.sweepMs);
  sweep.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(trim);
    clearInterval(sweep);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  if (config.localProbe) app.scheduler.start(config.schedulerTickMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
