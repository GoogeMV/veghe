import { randomBytes } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { REGION_PATTERN } from "../config.js";
import type { Probe } from "../db.js";
import { bearerToken, requireAdmin, sha256 } from "../lib/auth.js";
import { newMonitorId } from "../lib/ids.js";

declare module "fastify" {
  interface FastifyRequest {
    probe: Probe | null;
  }
}

const CreateProbeBody = Type.Object(
  { region: Type.String({ pattern: REGION_PATTERN.source }) },
  { additionalProperties: false },
);
const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 32 }) });

/** Admin side: register and remove probes. */
export const probeAdminRoutes: FastifyPluginAsyncTypebox = async (app) => {
  requireAdmin(app);

  app.get("/probes", async () => ({
    local: app.config.localProbe ? app.config.localRegion : null,
    probes: app.repo.listProbes(),
  }));

  app.post("/probes", { schema: { body: CreateProbeBody } }, async (request, reply) => {
    const { region } = request.body;
    const taken =
      (app.config.localProbe && region === app.config.localRegion) ||
      app.repo.listProbes().some((probe) => probe.region === region);
    if (taken) {
      return reply
        .code(409)
        .send({ error: "region_taken", message: `region "${region}" already has a probe` });
    }

    // Shown once and stored only as a hash, like a password.
    const token = randomBytes(24).toString("hex");
    const probe = app.repo.createProbe(
      newMonitorId(),
      region,
      sha256(token).toString("hex"),
      Date.now(),
    );
    app.bus.publish({ type: "monitors" });
    return reply.code(201).send({ ...probe, token });
  });

  app.delete("/probes/:id", { schema: { params: IdParams } }, async (request, reply) => {
    if (!app.repo.deleteProbe(request.params.id)) {
      return reply.code(404).send({ error: "not_found", message: "no such probe" });
    }
    app.bus.publish({ type: "monitors" });
    return reply.code(204).send();
  });
};

const ClaimBody = Type.Object(
  { limit: Type.Integer({ minimum: 1, maximum: 100, default: 10 }) },
  { additionalProperties: false },
);

const ResultsBody = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          monitorId: Type.String({ minLength: 1, maxLength: 32 }),
          ok: Type.Boolean(),
          statusCode: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
          latencyMs: Type.Union([Type.Integer({ minimum: 0, maximum: 600_000 }), Type.Null()]),
          error: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

/**
 * Agent side: the two calls a remote probe makes. A probe token identifies
 * exactly one region, so an agent cannot vote as anyone else; the worst a
 * leaked token can do is lie for its own region, which quorum is there to
 * outvote.
 */
export const probeAgentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorateRequest("probe", null);

  app.addHook("onRequest", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const probe = token
      ? app.repo.authenticateProbe(sha256(token).toString("hex"), Date.now())
      : null;
    if (!probe) {
      return reply.code(401).send({ error: "unauthorized", message: "probe token required" });
    }
    request.probe = probe;
  });

  app.post("/claim", { schema: { body: ClaimBody } }, async (request) => {
    const probe = request.probe as Probe;
    return {
      region: probe.region,
      jobs: app.repo.claim(probe.region, Date.now(), request.body.limit),
    };
  });

  app.post("/results", { schema: { body: ResultsBody } }, async (request) => {
    const probe = request.probe as Probe;
    // Stamped with the server's clock: agents' clocks are not trusted to agree.
    const at = Date.now();
    let recorded = 0;
    for (const { monitorId, ...result } of request.body.results) {
      const outcome = app.repo.recordResult(monitorId, probe.region, result, at);
      if (outcome) {
        recorded++;
        app.publishOutcome(outcome);
      }
    }
    return { recorded };
  });
};
