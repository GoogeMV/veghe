import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { DAY_MS, dayOf, type Monitor } from "../db.js";
import { parseTarget } from "../lib/net.js";

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 32 }) });

const HISTORY_DAYS = 90;
const LATENCY_POINTS = 120;

type Overall = "operational" | "degraded" | "outage" | "unknown";

function overallOf(monitors: Monitor[]): Overall {
  const active = monitors.filter((m) => !m.paused && m.status !== "pending");
  if (active.length === 0) return "unknown";
  const down = active.filter((m) => m.status === "down").length;
  if (down === active.length) return "outage";
  return down > 0 || active.some((m) => m.status === "degraded") ? "degraded" : "operational";
}

function ratio(up: number, total: number): number | null {
  return total === 0 ? null : up / total;
}

function describeTarget(url: string): { kind: string; host: string } {
  try {
    const target = parseTarget(url);
    return { kind: target.kind, host: new URL(url).host };
  } catch {
    return { kind: "http", host: "" };
  }
}

export const statusRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Everything the public page needs in one response. Monitors are exposed
   * by host only: full URLs can carry tokens in the path or query string.
   */
  app.get("/status", async () => {
    const now = Date.now();
    const today = dayOf(now);
    const firstDay = today - (HISTORY_DAYS - 1);
    const monitors = app.repo.listMonitors();

    return {
      generatedAt: now,
      overall: overallOf(monitors),
      monitors: monitors.map((monitor) => {
        const byDay = new Map(app.repo.dailyStats(monitor.id, firstDay).map((d) => [d.day, d]));
        const days = Array.from({ length: HISTORY_DAYS }, (_, i) => {
          const day = firstDay + i;
          const stat = byDay.get(day);
          return { day, total: stat?.total ?? 0, up: stat?.up ?? 0 };
        });
        const sum = (from: number) =>
          days
            .filter((d) => d.day >= from)
            .reduce((acc, d) => ({ up: acc.up + d.up, total: acc.total + d.total }), {
              up: 0,
              total: 0,
            });
        const d7 = sum(today - 6);
        const d90 = sum(firstDay);

        return {
          id: monitor.id,
          name: monitor.name,
          ...describeTarget(monitor.url),
          status: monitor.status,
          paused: monitor.paused,
          intervalSeconds: monitor.intervalSeconds,
          lastCheckedAt: monitor.lastCheckedAt,
          lastLatencyMs: monitor.lastLatencyMs,
          lastError: monitor.status === "up" ? null : monitor.lastError,
          uptime: {
            h24: app.repo.uptimeSince(monitor.id, now - DAY_MS),
            d7: ratio(d7.up, d7.total),
            d90: ratio(d90.up, d90.total),
          },
          regions: app.repo.regionsOf(monitor, now).map((region) => ({
            ...region,
            lastError: region.status === "down" ? region.lastError : null,
          })),
          days,
          latency: app.repo
            .recentChecks(monitor.id, LATENCY_POINTS)
            .reverse()
            .map((c) => ({ at: c.at, ms: c.latencyMs, ok: c.ok, region: c.region })),
        };
      }),
      incidents: app.repo.recentIncidents(20),
    };
  });

  /** One monitor in depth, for the page's detail panel. Public, and as careful about the URL. */
  app.get("/status/:id", { schema: { params: IdParams } }, async (request, reply) => {
    const monitor = app.repo.getMonitor(request.params.id);
    if (!monitor) return reply.code(404).send({ error: "not_found", message: "no such monitor" });
    const now = Date.now();
    return {
      id: monitor.id,
      name: monitor.name,
      ...describeTarget(monitor.url),
      status: monitor.status,
      intervalSeconds: monitor.intervalSeconds,
      failureThreshold: monitor.failureThreshold,
      regions: app.repo.regionStats(monitor.id, now - DAY_MS),
      checks: app.repo.recentChecks(monitor.id, 40),
      incidents: app.repo.incidentsFor(monitor.id, 10),
    };
  });
};
