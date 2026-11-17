import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { requireAdmin } from "../lib/auth.js";
import { newMonitorId } from "../lib/ids.js";
import { parseHttpUrl, parseTarget, TargetError } from "../lib/net.js";

const CreateBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    intervalSeconds: Type.Integer({ minimum: 10, maximum: 86_400, default: 60 }),
    timeoutMs: Type.Integer({ minimum: 500, maximum: 30_000, default: 5000 }),
    failureThreshold: Type.Integer({ minimum: 1, maximum: 10, default: 2 }),
    keyword: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    webhookUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 32 }) });
const PatchBody = Type.Object({ paused: Type.Boolean() }, { additionalProperties: false });

export const monitorRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Scoped to this plugin: every route below requires the admin token.
  requireAdmin(app);

  app.get("/monitors", async () => ({ monitors: app.repo.listMonitors() }));

  app.post("/monitors", { schema: { body: CreateBody } }, async (request, reply) => {
    const body = request.body;
    try {
      parseTarget(body.url);
      if (body.webhookUrl !== undefined) parseHttpUrl(body.webhookUrl);
    } catch (err) {
      if (err instanceof TargetError) {
        return reply.code(400).send({ error: "invalid_url", message: err.message });
      }
      throw err;
    }
    if (body.timeoutMs >= body.intervalSeconds * 1000) {
      return reply
        .code(400)
        .send({ error: "invalid_timeout", message: "timeoutMs must be shorter than the interval" });
    }

    const monitor = app.repo.createMonitor(
      {
        id: newMonitorId(),
        name: body.name.trim(),
        url: body.url,
        intervalSeconds: body.intervalSeconds,
        timeoutMs: body.timeoutMs,
        failureThreshold: body.failureThreshold,
        keyword: body.keyword ?? null,
        webhookUrl: body.webhookUrl ?? null,
      },
      Date.now(),
    );
    app.bus.publish({ type: "monitors" });
    return reply.code(201).send(monitor);
  });

  app.patch(
    "/monitors/:id",
    { schema: { params: IdParams, body: PatchBody } },
    async (request, reply) => {
      if (!app.repo.setPaused(request.params.id, request.body.paused, Date.now())) {
        return reply.code(404).send({ error: "not_found", message: "no such monitor" });
      }
      app.bus.publish({ type: "monitors" });
      return app.repo.getMonitor(request.params.id);
    },
  );

  app.delete("/monitors/:id", { schema: { params: IdParams } }, async (request, reply) => {
    if (!app.repo.deleteMonitor(request.params.id)) {
      return reply.code(404).send({ error: "not_found", message: "no such monitor" });
    }
    app.bus.publish({ type: "monitors" });
    return reply.code(204).send();
  });
};
