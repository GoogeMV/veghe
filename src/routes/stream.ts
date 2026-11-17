import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { BusEvent } from "../lib/bus.js";

const HEARTBEAT_MS = 25_000;

export const streamRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Public, like the status page it feeds: events carry ids and timings only.
  app.get("/stream", (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const unsubscribe = app.bus.subscribe((event: BusEvent) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    // Comment frames keep proxies from closing a quiet connection.
    const heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);
    app.metrics.sseClients.inc();

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      app.metrics.sseClients.dec();
    });
  });
};
