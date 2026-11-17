import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { type Monitor, MonitorRepository, type Outcome } from "./db.js";
import { sha256 } from "./lib/auth.js";
import { EventBus } from "./lib/bus.js";
import { type Checker, runCheck } from "./lib/checker.js";
import { newMonitorId } from "./lib/ids.js";
import { notify } from "./lib/notify.js";
import { Scheduler } from "./lib/scheduler.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { monitorRoutes } from "./routes/monitors.js";
import { probeAdminRoutes, probeAgentRoutes } from "./routes/probes.js";
import { statusRoutes } from "./routes/status.js";
import { streamRoutes } from "./routes/stream.js";
import { systemRoutes } from "./routes/system.js";

declare module "fastify" {
  interface FastifyInstance {
    repo: MonitorRepository;
    config: Config;
    metrics: Metrics;
    bus: EventBus;
    scheduler: Scheduler;
    /** Everything that happens after a check result is committed, whoever produced it. */
    publishOutcome: (outcome: Outcome) => void;
    /** Re-evaluates every monitor for silent regions; returns how many changed. */
    sweep: (at?: number) => number;
  }
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface AppDeps {
  /** Replaces the built-in probe's real checker; tests use this to script outcomes. */
  check?: Checker;
  /** Overrides the webhook retry schedule; tests use short delays. */
  retryDelaysMs?: number[];
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 64 * 1024,
    // SSE connections never go idle; without this, close() would wait on them forever.
    forceCloseConnections: true,
    // Fastify's defaults silently repair request bodies: unknown fields are
    // stripped and values coerced, which turns a probe's `latencyMs: null`
    // into 0 and `error: null` into "". Validate what was actually sent.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const repo = new MonitorRepository(config.dbPath);
  const metrics = createMetrics();
  const bus = new EventBus();

  for (const { region, token } of config.probeTokens) {
    repo.upsertProbe(newMonitorId(), region, sha256(token).toString("hex"), Date.now());
  }

  const publishIncident = (
    monitor: Monitor,
    event: "opened" | "resolved",
    at: number,
    cause: string | null,
    incidentStartedAt: number | null,
  ): void => {
    app.log.info({ monitor: monitor.id, event, cause }, "incident state changed");
    if (event === "opened") metrics.incidentsOpened.inc();
    bus.publish({ type: "incident", event, monitorId: monitor.id, at });

    if (monitor.webhookUrl) {
      void notify(
        monitor.webhookUrl,
        {
          event: event === "opened" ? "incident.opened" : "incident.resolved",
          monitor: { id: monitor.id, name: monitor.name },
          at,
          cause,
          ...(incidentStartedAt !== null && { durationMs: at - incidentStartedAt }),
        },
        {
          allowPrivate: config.allowPrivateTargets,
          secret: config.webhookSecret,
          ...(deps.retryDelaysMs && { retryDelaysMs: deps.retryDelaysMs }),
        },
      ).then((result) => metrics.notifications.inc({ outcome: result }));
    }
  };

  const publishOutcome = (outcome: Outcome): void => {
    const { monitor, check, event } = outcome;
    metrics.checks.inc({ region: check.region, outcome: check.ok ? "up" : "down" });
    if (check.latencyMs !== null) {
      metrics.checkLatency.observe({ region: check.region }, check.latencyMs / 1000);
    }

    bus.publish({
      type: "check",
      monitorId: monitor.id,
      region: check.region,
      at: check.at,
      ok: check.ok,
      latencyMs: check.latencyMs,
      status: monitor.status,
    });
    if (event) {
      publishIncident(monitor, event, check.at, outcome.cause, outcome.incidentStartedAt);
    }
  };

  /**
   * Looks for monitors whose status should change because a region stopped
   * reporting, and announces any change exactly as a check result would.
   */
  const sweep = (at = Date.now()): number => {
    let changed = 0;
    for (const { id } of repo.listMonitors()) {
      const change = repo.reevaluate(id, at);
      if (!change) continue;
      changed++;
      bus.publish({ type: "monitors" });
      if (change.event) {
        publishIncident(change.monitor, change.event, at, change.cause, change.incidentStartedAt);
      }
    }
    return changed;
  };

  const scheduler = new Scheduler({
    repo,
    region: config.localRegion,
    check:
      deps.check ?? ((target) => runCheck(target, { allowPrivate: config.allowPrivateTargets })),
    concurrency: config.checkConcurrency,
    onResult: publishOutcome,
    onError: (err) => app.log.error({ err }, "scheduler tick failed"),
  });

  app.decorate("repo", repo);
  app.decorate("config", config);
  app.decorate("metrics", metrics);
  app.decorate("bus", bus);
  app.decorate("scheduler", scheduler);
  app.decorate("publishOutcome", publishOutcome);
  app.decorate("sweep", sweep);

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalMax,
    timeWindow: config.rateLimit.windowMs,
    // Probes poll every second by design, and are authenticated; the limit
    // exists for anonymous traffic.
    allowList: (request) => request.url.startsWith("/api/probe/"),
  });

  app.addHook("onResponse", (request, reply, done) => {
    metrics.httpRequestDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status: reply.statusCode,
      },
      reply.elapsedTime / 1000,
    );
    done();
  });

  app.addHook("onClose", async () => {
    scheduler.stop();
    repo.close();
  });

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/static/" });
  app.get("/", (_request, reply) => reply.sendFile("index.html"));

  await app.register(systemRoutes);
  await app.register(statusRoutes, { prefix: "/api" });
  await app.register(streamRoutes, { prefix: "/api" });
  await app.register(monitorRoutes, { prefix: "/api" });
  await app.register(probeAdminRoutes, { prefix: "/api" });
  await app.register(probeAgentRoutes, { prefix: "/api/probe" });

  return app;
}
