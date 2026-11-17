import type { AddressInfo } from "node:net";
import { createServer as createTcpServer } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/lib/agent.js";
import type { CheckResult } from "../src/lib/checker.js";
import { runCheck } from "../src/lib/checker.js";
import {
  AUTH,
  createMonitor,
  createProbe,
  FAIL,
  listen,
  PASS,
  serve,
  testApp,
  waitFor,
} from "./helpers.js";

let app: FastifyInstance | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function agentFor(serverUrl: string, token: string, result: () => CheckResult): Agent {
  return new Agent({ serverUrl, token, concurrency: 10, check: async () => ({ ...result() }) });
}

describe("admin API", () => {
  it("rejects writes without the admin token", async () => {
    app = await testApp();
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Basic x" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/monitors",
        headers,
        payload: { name: "x", url: "https://x.test" },
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await app.inject({ method: "GET", url: "/api/monitors" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/probes" })).statusCode).toBe(401);
  });

  it("creates monitors of every kind, with defaults", async () => {
    app = await testApp();
    const monitor = await createMonitor(app);
    expect(monitor).toMatchObject({
      name: "API",
      intervalSeconds: 60,
      timeoutMs: 5000,
      failureThreshold: 2,
      status: "pending",
      paused: false,
    });
    expect(monitor.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{10}$/);

    await createMonitor(app, { url: "tcp://db.test:5432" });
    await createMonitor(app, { url: "tls://www.test" });
    const { monitors } = (await app.inject({ method: "GET", url: "/api/status" })).json();
    expect(monitors.map((m: { kind: string; host: string }) => [m.kind, m.host])).toEqual([
      ["http", "api.test"],
      ["tcp", "db.test:5432"],
      ["tls", "www.test"],
    ]);
  });

  it.each([
    [{ url: "ftp://files.test" }, "invalid_url"],
    [{ url: "not a url" }, "invalid_url"],
    [{ url: "tcp://no-port.test" }, "invalid_url"],
    [{ webhookUrl: "javascript:alert(1)" }, "invalid_url"],
    [{ intervalSeconds: 10, timeoutMs: 10_000 }, "invalid_timeout"],
  ])("rejects %j", async (body, error) => {
    app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/monitors",
      headers: AUTH,
      payload: { name: "API", url: "https://api.test", ...body },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
  });

  it("rejects out-of-range and unknown fields at the schema", async () => {
    app = await testApp();
    for (const body of [{ intervalSeconds: 1 }, { failureThreshold: 0 }, { surprise: true }]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/monitors",
        headers: AUTH,
        payload: { name: "API", url: "https://api.test", ...body },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("pauses, resumes and deletes, cascading history", async () => {
    app = await testApp({}, { check: async () => ({ ...FAIL }) });
    const monitor = await createMonitor(app, { failureThreshold: 1 });
    await app.scheduler.tick();
    expect(app.repo.recentIncidents(10)).toHaveLength(1);

    const paused = await app.inject({
      method: "PATCH",
      url: `/api/monitors/${monitor.id}`,
      headers: AUTH,
      payload: { paused: true },
    });
    expect(paused.json().paused).toBe(true);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/monitors/${monitor.id}`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(204);
    expect(app.repo.recentIncidents(10)).toHaveLength(0);
    expect(app.repo.recentChecks(monitor.id, 10)).toHaveLength(0);

    const again = await app.inject({
      method: "DELETE",
      url: `/api/monitors/${monitor.id}`,
      headers: AUTH,
    });
    expect(again.statusCode).toBe(404);
  });
});

describe("GET /api/status", () => {
  it("is public, exposes the host but never the full URL", async () => {
    app = await testApp({}, { check: async () => ({ ...PASS }) });
    await createMonitor(app, { url: "https://api.test/health?token=s3cret" });
    await app.scheduler.tick();

    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("s3cret");

    const status = res.json();
    expect(status.overall).toBe("operational");
    const [monitor] = status.monitors;
    expect(monitor).toMatchObject({ host: "api.test", status: "up", lastLatencyMs: 30 });
    expect(monitor.uptime).toEqual({ h24: 1, d7: 1, d90: 1 });
    expect(monitor.days).toHaveLength(90);
    expect(monitor.days.at(-1)).toMatchObject({ total: 1, up: 1 });
    expect(monitor.regions).toMatchObject([{ region: "local", status: "up", stale: false }]);
    expect(monitor.latency).toEqual([
      { at: expect.any(Number), ms: 30, ok: true, region: "local" },
    ]);
  });

  it("summarises overall state: degraded when some are down, outage when all are", async () => {
    const failing = new Set<string>(["https://b.test/"]);
    app = await testApp(
      {},
      { check: async (t) => (failing.has(t.url) ? { ...FAIL } : { ...PASS }) },
    );
    const a = await createMonitor(app, { url: "https://a.test/", failureThreshold: 1 });
    const b = await createMonitor(app, { url: "https://b.test/", failureThreshold: 1 });
    const overall = async () =>
      (await (app as FastifyInstance).inject({ method: "GET", url: "/api/status" })).json().overall;

    expect(await overall()).toBe("unknown");
    await app.scheduler.tick();
    expect(await overall()).toBe("degraded");

    failing.add("https://a.test/");
    for (const id of [a.id, b.id]) app.repo.makeDue(id, 0);
    await app.scheduler.tick();
    expect(await overall()).toBe("outage");

    const { incidents } = (await app.inject({ method: "GET", url: "/api/status" })).json();
    expect(incidents).toHaveLength(2);
    expect(incidents[0]).toMatchObject({ resolvedAt: null, cause: "HTTP 500" });
  });
});

describe("probes", () => {
  it("issues a token once and refuses a second probe for the same region", async () => {
    app = await testApp();
    const token = await createProbe(app, "eu-west");
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    const list = (await app.inject({ method: "GET", url: "/api/probes", headers: AUTH })).json();
    expect(list.local).toBe("local");
    expect(list.probes).toMatchObject([{ region: "eu-west", lastSeenAt: null }]);
    expect(JSON.stringify(list)).not.toContain(token);

    for (const region of ["eu-west", "local"]) {
      const dup = await app.inject({
        method: "POST",
        url: "/api/probes",
        headers: AUTH,
        payload: { region },
      });
      expect(dup.statusCode).toBe(409);
    }
    const bad = await app.inject({
      method: "POST",
      url: "/api/probes",
      headers: AUTH,
      payload: { region: "EU West!" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("rejects agents without a valid probe token, including the admin token", async () => {
    app = await testApp();
    for (const headers of [{}, { authorization: "Bearer nope" }, AUTH]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/probe/claim",
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("accepts probes declared in configuration", async () => {
    app = await testApp({
      localProbe: false,
      probeTokens: [{ region: "eu-west", token: "configured-token-0123456789" }],
    });
    await createMonitor(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/probe/claim",
      headers: { authorization: "Bearer configured-token-0123456789" },
      payload: {},
    });
    expect(res.json()).toMatchObject({ region: "eu-west", jobs: [{ timeoutMs: 5000 }] });
  });

  it("three real agents over HTTP: a minority degrades, a majority opens an incident", async () => {
    app = await testApp({ localProbe: false });
    const serverUrl = await serve(app);
    const monitor = await createMonitor(app, { failureThreshold: 1 });

    const verdict: Record<string, CheckResult> = {
      "eu-west": PASS,
      "us-east": PASS,
      "ap-south": PASS,
    };
    const agents: Record<string, Agent> = {};
    for (const region of Object.keys(verdict)) {
      const token = await createProbe(app, region);
      agents[region] = agentFor(serverUrl, token, () => verdict[region] as CheckResult);
    }
    const round = async () => {
      (app as FastifyInstance).repo.makeDue(monitor.id, 0);
      for (const agent of Object.values(agents)) await agent.tick();
      return (app as FastifyInstance).repo.getMonitor(monitor.id)?.status;
    };

    expect(await round()).toBe("up");

    verdict["ap-south"] = FAIL;
    expect(await round()).toBe("degraded");
    expect(app.repo.recentIncidents(10)).toHaveLength(0);

    verdict["us-east"] = FAIL;
    expect(await round()).toBe("down");
    expect(app.repo.recentIncidents(10)).toMatchObject([{ cause: "HTTP 500", resolvedAt: null }]);

    verdict["us-east"] = PASS;
    verdict["ap-south"] = PASS;
    expect(await round()).toBe("up");
    expect(app.repo.recentIncidents(10)[0]?.resolvedAt).not.toBeNull();

    // Every agent's checks were attributed to its own region and marked it as seen.
    const regions = new Set(app.repo.recentChecks(monitor.id, 100).map((check) => check.region));
    expect([...regions].sort()).toEqual(["ap-south", "eu-west", "us-east"]);
    expect(app.repo.listProbes().every((probe) => probe.lastSeenAt !== null)).toBe(true);
  });

  it("two agents sharing a region split the work instead of duplicating it", async () => {
    app = await testApp({ localProbe: false });
    const serverUrl = await serve(app);
    for (const name of ["a", "b", "c", "d"]) await createMonitor(app, { name });
    const token = await createProbe(app, "eu-west");

    let checks = 0;
    const count = () => {
      checks++;
      return PASS;
    };
    const [one, two] = [agentFor(serverUrl, token, count), agentFor(serverUrl, token, count)];
    const claimed = await Promise.all([one.tick(), two.tick()]);

    expect(claimed.reduce((sum, n) => sum + n, 0)).toBe(4);
    expect(checks).toBe(4);
  });

  it("ignores results for monitors that no longer exist and rejects malformed ones", async () => {
    app = await testApp({ localProbe: false });
    const token = await createProbe(app, "eu-west");
    const headers = { authorization: `Bearer ${token}` };

    const ghost = await app.inject({
      method: "POST",
      url: "/api/probe/results",
      headers,
      payload: { results: [{ monitorId: "ghost", ...PASS }] },
    });
    expect(ghost.json()).toEqual({ recorded: 0 });

    // A failed check has no latency and no status code; null must survive as null.
    const monitor = await createMonitor(app, { failureThreshold: 1 });
    await app.inject({ method: "POST", url: "/api/probe/claim", headers, payload: {} });
    const refused = { ok: false, statusCode: null, latencyMs: null, error: "ECONNREFUSED" };
    await app.inject({
      method: "POST",
      url: "/api/probe/results",
      headers,
      payload: { results: [{ monitorId: monitor.id, ...refused }] },
    });
    expect(app.repo.recentChecks(monitor.id, 1)[0]).toMatchObject(refused);
    expect(app.repo.getMonitor(monitor.id)).toMatchObject({
      status: "down",
      lastError: "ECONNREFUSED",
    });

    const malformed = await app.inject({
      method: "POST",
      url: "/api/probe/results",
      headers,
      payload: { results: [{ monitorId: "x", ok: "yes" }] },
    });
    expect(malformed.statusCode).toBe(400);
  });
});

describe("real checks", () => {
  it("http: classifies status codes, keywords, timeouts and refused connections", async () => {
    const target = await listen((req, res) => {
      if (req.url === "/ok") res.end('{"status":"ok"}');
      else if (req.url === "/redirect") res.writeHead(302, { location: "/ok" }).end();
      else if (req.url === "/slow") setTimeout(() => res.end("late"), 2000);
      else res.writeHead(503).end("nope");
    });
    cleanups.push(target.close);
    const check = (path: string, keyword: string | null = null, timeoutMs = 1000) =>
      runCheck({ url: `${target.url}${path}`, timeoutMs, keyword }, { allowPrivate: true });

    expect(await check("/ok")).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(await check("/ok", '"status":"ok"')).toMatchObject({ ok: true });
    expect(await check("/ok", "healthy")).toMatchObject({
      ok: false,
      error: "keyword not found in response",
    });
    expect(await check("/redirect")).toMatchObject({ ok: true, statusCode: 302 });
    expect(await check("/boom")).toMatchObject({ ok: false, statusCode: 503, error: "HTTP 503" });
    expect(await check("/slow", null, 200)).toMatchObject({
      ok: false,
      statusCode: null,
      error: "timeout after 200ms",
    });

    await target.close();
    // A pooled keep-alive socket reports RESET, a fresh connection REFUSED.
    expect((await check("/ok")).error).toMatch(/^ECONN(REFUSED|RESET)$/);
  });

  it("tcp: up while the port accepts connections, ECONNREFUSED once it does not", async () => {
    const server = createTcpServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const check = () => runCheck({ url, timeoutMs: 1000, keyword: null }, { allowPrivate: true });

    expect(await check()).toMatchObject({ ok: true, statusCode: null, error: null });

    await new Promise((resolve) => server.close(resolve));
    expect(await check()).toMatchObject({ ok: false, latencyMs: null, error: "ECONNREFUSED" });
  });

  it("tls: a plain-text port fails the handshake instead of hanging", async () => {
    const target = await listen((_req, res) => res.end("not tls"));
    cleanups.push(target.close);
    const result = await runCheck(
      { url: `tls://127.0.0.1:${target.port}`, timeoutMs: 1000, keyword: null },
      { allowPrivate: true },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("refuses private targets when they are not allowed", async () => {
    for (const url of ["http://127.0.0.1:1/", "tcp://127.0.0.1:5432", "tls://127.0.0.1"]) {
      const result = await runCheck(
        { url, timeoutMs: 500, keyword: null },
        { allowPrivate: false },
      );
      expect(result).toMatchObject({
        ok: false,
        error: "target resolves to a private or loopback address",
      });
    }
  });
});

describe("live updates and notifications", () => {
  it("streams check and incident events over SSE", async () => {
    app = await testApp({}, { check: async () => ({ ...FAIL }) });
    const serverUrl = await serve(app);

    const controller = new AbortController();
    const res = await fetch(`${serverUrl}/api/stream`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const monitor = await createMonitor(app, { failureThreshold: 1 });
    await app.scheduler.tick();

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: incident")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();

    expect(text).toContain("event: monitors");
    expect(text).toMatch(/event: check\ndata: .*"region":"local"/);
    const incident = /event: incident\ndata: (.+)\n/.exec(text)?.[1];
    expect(JSON.parse(incident ?? "{}")).toMatchObject({
      type: "incident",
      event: "opened",
      monitorId: monitor.id,
    });
  });

  it("delivers incident webhooks on open and on resolve", async () => {
    const received: { event: string; durationMs?: number; monitor: { name: string } }[] = [];
    const hook = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.end("ok");
      });
    });
    cleanups.push(hook.close);

    let result = FAIL;
    app = await testApp({}, { check: async () => ({ ...result }) });
    const monitor = await createMonitor(app, { failureThreshold: 1, webhookUrl: hook.url });

    await app.scheduler.tick();
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({
      event: "incident.opened",
      monitor: { name: "API" },
      cause: "HTTP 500",
    });
    expect(received[0]).not.toHaveProperty("durationMs");

    result = PASS;
    app.repo.makeDue(monitor.id, 0);
    await app.scheduler.tick();
    await waitFor(() => received.length === 2);
    expect(received[1]).toMatchObject({ event: "incident.resolved" });
    expect(received[1]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("system", () => {
  it("serves health, metrics and the status page", async () => {
    app = await testApp({}, { check: async () => ({ ...PASS }) });
    await createMonitor(app);
    await app.scheduler.tick();

    expect((await app.inject({ method: "GET", url: "/healthz" })).json().status).toBe("ok");
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain('checks_total{region="local",outcome="up"} 1');
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("veghe");
  });
});
