import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MonitorRepository } from "../src/db.js";
import { badgeMessage, renderBadge } from "../src/lib/badge.js";
import type { CheckResult } from "../src/lib/checker.js";
import { notify, sign } from "../src/lib/notify.js";
import { createMonitor, FAIL, listen, PASS, testApp, waitFor } from "./helpers.js";

let app: FastifyInstance | undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("sweeper (regions that go silent)", () => {
  const T0 = 1_800_000_000_000;
  const setup = () => {
    const repo = new MonitorRepository(":memory:");
    repo.createMonitor(
      {
        id: "a",
        name: "a",
        url: "https://a.test/",
        intervalSeconds: 60,
        timeoutMs: 5000,
        failureThreshold: 1,
        keyword: null,
        webhookUrl: null,
      },
      T0,
    );
    const report = (region: string, result: CheckResult, at: number) => {
      repo.claim(region, at, 10);
      repo.recordResult("a", region, result, at);
    };
    return { repo, report };
  };

  // Freshness window for a 60s monitor is 180s.

  it("resolves an incident once the regions that reported it have gone stale", () => {
    const { repo, report } = setup();
    report("eu-west", FAIL, T0);
    report("us-east", FAIL, T0);
    report("ap-south", PASS, T0);
    expect(repo.getMonitor("a")?.status).toBe("down");

    // Nothing to do while every vote is fresh.
    expect(repo.reevaluate("a", T0 + 60_000)).toBeNull();

    // eu-west and us-east die. ap-south reports once more while their votes
    // still count, so its own result changes nothing...
    report("ap-south", PASS, T0 + 170_000);
    expect(repo.getMonitor("a")?.status).toBe("down");

    // ...and then no result arrives at the moment their votes expire. Only
    // the sweep notices.
    const change = repo.reevaluate("a", T0 + 240_000);
    expect(change).toMatchObject({ event: "resolved", cause: null, incidentStartedAt: T0 });
    expect(change?.monitor.status).toBe("up");
    expect(repo.recentIncidents(5)[0]?.resolvedAt).toBe(T0 + 240_000);
    repo.close();
  });

  it("never lets one region open an incident alone while others are known", () => {
    const { repo, report } = setup();
    report("eu-west", PASS, T0);
    report("us-east", PASS, T0);
    report("ap-south", FAIL, T0);
    expect(repo.getMonitor("a")?.status).toBe("degraded");

    // The two healthy probes die; ap-south keeps failing and becomes the
    // only fresh voice. That is suspicion, not an outage.
    report("ap-south", FAIL, T0 + 100_000);
    expect(repo.reevaluate("a", T0 + 250_000)).toBeNull();
    expect(repo.getMonitor("a")?.status).toBe("degraded");
    expect(repo.recentIncidents(5)).toHaveLength(0);

    // A second region confirming it is enough.
    report("us-east", FAIL, T0 + 260_000);
    expect(repo.getMonitor("a")?.status).toBe("down");
    expect(repo.recentIncidents(5)).toHaveLength(1);
    repo.close();
  });

  it("after a restart, the first probe back cannot flap a monitor on its own", () => {
    const { repo, report } = setup();
    report("eu-west", PASS, T0);
    report("us-east", PASS, T0);
    report("ap-south", FAIL, T0);

    // The server is down for an hour: every vote is stale. ap-south, still
    // partitioned, happens to report first when it comes back.
    const later = T0 + 3_600_000;
    report("ap-south", FAIL, later);
    expect(repo.getMonitor("a")?.status).toBe("degraded");
    report("eu-west", PASS, later + 1000);
    report("us-east", PASS, later + 2000);
    expect(repo.recentIncidents(5)).toHaveLength(0);
    repo.close();
  });

  it("still lets a monitor with a single region go down", () => {
    const { repo, report } = setup();
    report("eu-west", FAIL, T0);
    expect(repo.getMonitor("a")?.status).toBe("down");
    repo.close();
  });

  it("keeps the last known status when no region is reporting at all", () => {
    const { repo, report } = setup();
    report("eu-west", FAIL, T0);
    expect(repo.getMonitor("a")?.status).toBe("down");
    expect(repo.reevaluate("a", T0 + 3_600_000)).toBeNull();
    expect(repo.getMonitor("a")?.status).toBe("down");
    expect(repo.recentIncidents(5)[0]?.resolvedAt).toBeNull();
    repo.close();
  });

  it("leaves paused monitors alone and announces changes through the app", async () => {
    app = await testApp({ localProbe: false });
    const monitor = await createMonitor(app, { failureThreshold: 1, intervalSeconds: 60 });
    const at = Date.now();
    for (const region of ["eu-west", "us-east", "ap-south"]) app.repo.claim(region, at, 10);
    app.repo.recordResult(monitor.id, "eu-west", FAIL, at - 100_000);
    app.repo.recordResult(monitor.id, "us-east", FAIL, at - 100_000);
    app.repo.recordResult(monitor.id, "ap-south", PASS, at);
    expect(app.repo.getMonitor(monitor.id)?.status).toBe("down");

    const events: string[] = [];
    app.bus.subscribe((event) => events.push(event.type));
    // eu-west and us-east are now 190s old with a 180s freshness window.
    expect(app.sweep(at + 90_000)).toBe(1);
    expect(app.repo.getMonitor(monitor.id)?.status).toBe("up");
    expect(events).toEqual(["monitors", "incident"]);

    app.repo.setPaused(monitor.id, true, at);
    expect(app.sweep(at + 999_000)).toBe(0);
  });
});

describe("webhook delivery", () => {
  const payload = {
    event: "incident.opened" as const,
    monitor: { id: "m1", name: "API" },
    at: 1,
    cause: "HTTP 503",
  };

  it("signs each delivery so the receiver can verify it", async () => {
    const seen: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const hook = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({ headers: req.headers, body });
        res.end("ok");
      });
    });
    cleanups.push(hook.close);

    const secret = "a-shared-secret-of-enough-length";
    expect(await notify(hook.url, payload, { allowPrivate: true, secret })).toBe("sent");

    const [delivery] = seen;
    const timestamp = Number(delivery?.headers["x-veghe-timestamp"]);
    expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(5);
    expect(delivery?.headers["x-veghe-signature"]).toBe(
      `sha256=${sign(secret, timestamp, delivery?.body ?? "")}`,
    );
    // A different secret, body or timestamp gives a different signature.
    expect(sign("another-secret-0123456789", timestamp, delivery?.body ?? "")).not.toBe(
      sign(secret, timestamp, delivery?.body ?? ""),
    );
    expect(sign(secret, timestamp + 1, "x")).not.toBe(sign(secret, timestamp, "x"));

    // Without a secret there is no signature header at all.
    await notify(hook.url, payload, { allowPrivate: true });
    expect(seen[1]?.headers).not.toHaveProperty("x-veghe-signature");
  });

  it("retries a failing receiver with the same delivery id, then succeeds", async () => {
    const deliveries: (string | string[] | undefined)[] = [];
    const hook = await listen((req, res) => {
      deliveries.push(req.headers["x-veghe-delivery"]);
      req.resume();
      res.writeHead(deliveries.length < 3 ? 503 : 200).end();
    });
    cleanups.push(hook.close);

    const result = await notify(hook.url, payload, { allowPrivate: true, retryDelaysMs: [5, 5] });
    expect(result).toBe("sent");
    expect(deliveries).toHaveLength(3);
    expect(new Set(deliveries).size).toBe(1);
  });

  it("gives up after the last attempt, and does not retry a 4xx", async () => {
    let calls = 0;
    let status = 500;
    const hook = await listen((req, res) => {
      calls++;
      req.resume();
      res.writeHead(status).end();
    });
    cleanups.push(hook.close);
    const opts = { allowPrivate: true, retryDelaysMs: [5, 5] };

    expect(await notify(hook.url, payload, opts)).toBe("failed");
    expect(calls).toBe(3);

    calls = 0;
    status = 410; // the receiver understood and refused
    expect(await notify(hook.url, payload, opts)).toBe("failed");
    expect(calls).toBe(1);

    expect(await notify("http://127.0.0.1:9/", payload, { allowPrivate: false })).toBe("failed");
  });

  it("is wired into incidents with the configured secret", async () => {
    const signatures: (string | string[] | undefined)[] = [];
    const hook = await listen((req, res) => {
      signatures.push(req.headers["x-veghe-signature"]);
      req.resume();
      res.end("ok");
    });
    cleanups.push(hook.close);

    app = await testApp(
      { webhookSecret: "configured-secret-0123456789" },
      { check: async () => ({ ...FAIL }), retryDelaysMs: [] },
    );
    await createMonitor(app, { failureThreshold: 1, webhookUrl: hook.url });
    await app.scheduler.tick();
    await waitFor(() => signatures.length === 1);
    expect(signatures[0]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("badges", () => {
  it("words the message from status and uptime", () => {
    expect(badgeMessage("up", 1)).toBe("up · 100%");
    expect(badgeMessage("up", 0.99999)).toBe("up · 99.99%"); // never rounded up to 100
    expect(badgeMessage("down", 0.9417)).toBe("down · 94.17%");
    expect(badgeMessage("pending", null)).toBe("pending");
    expect(badgeMessage("paused", 0.5)).toBe("paused");
  });

  it("renders self-contained SVG and escapes the monitor name", () => {
    const svg = renderBadge('API <prod> & "friends"', "up", "up · 100%");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20"/);
    expect(svg).not.toContain("<prod>");
    expect(svg).toContain("API &#60;prod&#62; &#38; &#34;friends&#34;");
    expect(svg).toContain("<title>");
    expect(svg).toContain("#2ea44f");
  });

  it("serves a badge per monitor, cacheable, and a 404 badge for unknown ids", async () => {
    app = await testApp({}, { check: async () => ({ ...PASS }) });
    const monitor = await createMonitor(app, { name: "Public API" });
    await app.scheduler.tick();

    const res = await app.inject({ method: "GET", url: `/badge/${monitor.id}.svg` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.body).toContain("Public API");
    expect(res.body).toContain("up · 100%");

    const missing = await app.inject({ method: "GET", url: "/badge/nope.svg" });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain("unknown monitor");
    expect((await app.inject({ method: "GET", url: "/badge/..%2Fetc.svg" })).statusCode).toBe(400);
  });
});

describe("GET /api/status/:id", () => {
  it("returns one monitor in depth, without its URL", async () => {
    let result: CheckResult = PASS;
    app = await testApp({}, { check: async () => ({ ...result }) });
    const monitor = await createMonitor(app, {
      url: "https://api.test/health?token=s3cret",
      failureThreshold: 1,
    });
    await app.scheduler.tick();
    result = FAIL;
    app.repo.makeDue(monitor.id, 0);
    await app.scheduler.tick();

    const res = await app.inject({ method: "GET", url: `/api/status/${monitor.id}` });
    expect(res.body).not.toContain("s3cret");
    const detail = res.json();
    expect(detail).toMatchObject({ name: "API", kind: "http", host: "api.test", status: "down" });
    expect(detail.regions).toEqual([
      { region: "local", checks: 2, uptime: 0.5, meanMs: 18, p95Ms: 30 },
    ]);
    expect(detail.checks).toHaveLength(2);
    expect(detail.checks[0]).toMatchObject({ region: "local", ok: false, error: "HTTP 500" });
    expect(detail.incidents).toMatchObject([{ cause: "HTTP 500", resolvedAt: null }]);

    expect((await app.inject({ method: "GET", url: "/api/status/nope" })).statusCode).toBe(404);
  });
});
