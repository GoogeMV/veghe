import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { dayOf } from "../db.js";
import { badgeMessage, renderBadge } from "../lib/badge.js";

const BadgeParams = Type.Object({ file: Type.String({ pattern: "^[A-Za-z0-9]{1,32}\\.svg$" }) });

export const systemRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/healthz", async () => ({ status: "ok", checksInFlight: app.scheduler.running }));

  /** Embeddable status badge: /badge/<monitor id>.svg */
  app.get("/badge/:file", { schema: { params: BadgeParams } }, async (request, reply) => {
    const monitor = app.repo.getMonitor(request.params.file.replace(/\.svg$/, ""));
    reply.header("content-type", "image/svg+xml; charset=utf-8");
    // Short enough to be current, long enough that a popular README does not hammer the server.
    reply.header("cache-control", "public, max-age=60");
    if (!monitor) return reply.code(404).send(renderBadge("veghe", "pending", "unknown monitor"));

    const days = app.repo.dailyStats(monitor.id, dayOf(Date.now()) - 89);
    const total = days.reduce((sum, day) => sum + day.total, 0);
    const up = days.reduce((sum, day) => sum + day.up, 0);
    const status = monitor.paused ? "paused" : monitor.status;
    return renderBadge(monitor.name, status, badgeMessage(status, total === 0 ? null : up / total));
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", app.metrics.registry.contentType);
    return app.metrics.registry.metrics();
  });
};
