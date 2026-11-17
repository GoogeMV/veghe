import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export interface Metrics {
  registry: Registry;
  httpRequestDuration: Histogram<"method" | "route" | "status">;
  checks: Counter<"region" | "outcome">;
  checkLatency: Histogram<"region">;
  incidentsOpened: Counter<string>;
  notifications: Counter<"outcome">;
  sseClients: Gauge<string>;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    httpRequestDuration: new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration by method, route and status code",
      labelNames: ["method", "route", "status"],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [registry],
    }),
    checks: new Counter({
      name: "checks_total",
      help: "Uptime checks recorded, by region and outcome",
      labelNames: ["region", "outcome"],
      registers: [registry],
    }),
    checkLatency: new Histogram({
      name: "check_latency_seconds",
      help: "Check latency of monitored targets, by region",
      labelNames: ["region"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    incidentsOpened: new Counter({
      name: "incidents_opened_total",
      help: "Incidents opened",
      registers: [registry],
    }),
    notifications: new Counter({
      name: "notifications_total",
      help: "Incident webhook deliveries by outcome",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    sseClients: new Gauge({
      name: "sse_clients",
      help: "Currently connected SSE stream clients",
      registers: [registry],
    }),
  };
}
