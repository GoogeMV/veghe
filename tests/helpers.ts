import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { type AppDeps, buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { Monitor } from "../src/db.js";
import type { CheckResult } from "../src/lib/checker.js";

export const ADMIN_TOKEN = "test-admin-token-0123456789";
export const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

export const PASS: CheckResult = { ok: true, statusCode: 200, latencyMs: 30, error: null };
export const FAIL: CheckResult = { ok: false, statusCode: 500, latencyMs: 5, error: "HTTP 500" };

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    logLevel: "silent",
    adminToken: ADMIN_TOKEN,
    allowPrivateTargets: true,
    localProbe: true,
    localRegion: "local",
    probeTokens: [],
    webhookSecret: null,
    sweepMs: 30_000,
    schedulerTickMs: 1000,
    checkConcurrency: 10,
    rawRetentionDays: 7,
    rateLimit: { globalMax: 10_000, windowMs: 60_000 },
  };
  return { ...base, ...overrides };
}

export async function testApp(
  overrides: Partial<Config> = {},
  deps: AppDeps = {},
): Promise<FastifyInstance> {
  return buildApp(testConfig(overrides), deps);
}

export async function createMonitor(
  app: FastifyInstance,
  body: Record<string, unknown> = {},
): Promise<Monitor> {
  const res = await app.inject({
    method: "POST",
    url: "/api/monitors",
    headers: AUTH,
    payload: { name: "API", url: "https://api.test/health", ...body },
  });
  if (res.statusCode !== 201) {
    throw new Error(`monitor creation failed: ${res.statusCode} ${res.body}`);
  }
  return res.json();
}

export async function createProbe(app: FastifyInstance, region: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/probes",
    headers: AUTH,
    payload: { region },
  });
  if (res.statusCode !== 201) {
    throw new Error(`probe creation failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().token;
}

/** Starts the app on an ephemeral port and returns its origin. */
export async function serve(app: FastifyInstance): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** A real HTTP server on an ephemeral port, to be a monitoring target or webhook receiver. */
export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
