import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitorRepository, type Outcome } from "../src/db.js";
import type { CheckResult } from "../src/lib/checker.js";
import { Scheduler } from "../src/lib/scheduler.js";

const UP: CheckResult = { ok: true, statusCode: 200, latencyMs: 42, error: null };
const DOWN: CheckResult = { ok: false, statusCode: 503, latencyMs: 10, error: "HTTP 503" };

let repo: MonitorRepository;
let clock: number;
let outcomes: Outcome[];

function add(id: string, overrides: { intervalSeconds?: number; failureThreshold?: number } = {}) {
  return repo.createMonitor(
    {
      id,
      name: id,
      url: `https://${id}.test/`,
      intervalSeconds: overrides.intervalSeconds ?? 60,
      timeoutMs: 5000,
      failureThreshold: overrides.failureThreshold ?? 2,
      keyword: null,
      webhookUrl: null,
    },
    clock,
  );
}

function scheduler(check: (id: string) => Promise<CheckResult> | CheckResult, concurrency = 10) {
  return new Scheduler({
    repo,
    region: "local",
    concurrency,
    now: () => clock,
    check: async (target) => check(new URL(target.url).hostname.replace(".test", "")),
    onResult: (outcome) => outcomes.push(outcome),
  });
}

/** A region reporting directly, as a remote agent would through the API. */
function report(region: string, id: string, result: CheckResult) {
  repo.claim(region, clock, 100);
  const outcome = repo.recordResult(id, region, result, clock);
  if (outcome) outcomes.push(outcome);
  return outcome;
}

beforeEach(() => {
  repo = new MonitorRepository(":memory:");
  clock = 1_800_000_000_000;
  outcomes = [];
});

afterEach(() => repo.close());

describe("Scheduler (built-in probe)", () => {
  it("checks a new monitor immediately, then not again until its interval elapses", async () => {
    add("a", { intervalSeconds: 60 });
    let calls = 0;
    const s = scheduler(() => {
      calls++;
      return UP;
    });

    await s.tick();
    expect(calls).toBe(1);
    expect(repo.getMonitor("a")).toMatchObject({ status: "up", lastLatencyMs: 42 });

    clock += 59_000;
    await s.tick();
    expect(calls).toBe(1);

    clock += 1000;
    await s.tick();
    expect(calls).toBe(2);
  });

  it("as the only region, opens one incident after the threshold and resolves on recovery", async () => {
    add("a", { failureThreshold: 2 });
    let result = DOWN;
    const s = scheduler(() => result);

    await s.tick();
    expect(repo.getMonitor("a")?.status).toBe("pending");
    expect(repo.recentIncidents(10)).toHaveLength(0);

    clock += 60_000;
    await s.tick();
    clock += 60_000;
    await s.tick();
    expect(repo.getMonitor("a")?.status).toBe("down");
    const [incident] = repo.recentIncidents(10);
    expect(repo.recentIncidents(10)).toHaveLength(1);
    expect(incident).toMatchObject({ cause: "HTTP 503", resolvedAt: null });

    result = UP;
    clock += 60_000;
    await s.tick();
    expect(repo.getMonitor("a")?.status).toBe("up");
    expect(repo.recentIncidents(10)[0]?.resolvedAt).toBe(clock);

    expect(outcomes.map((o) => o.event)).toEqual([null, "opened", null, "resolved"]);
    expect(outcomes.at(-1)?.incidentStartedAt).toBe(incident?.startedAt);
  });

  it("caps checks in flight at the concurrency limit and picks up the rest next tick", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) add(id);
    const seen: string[] = [];
    const s = scheduler((id) => {
      seen.push(id);
      return UP;
    }, 2);

    await s.tick();
    expect(seen).toHaveLength(2);
    await s.tick();
    await s.tick();
    expect(seen.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("skips paused monitors and checks them straight away once resumed", async () => {
    add("a");
    repo.setPaused("a", true, clock);
    let calls = 0;
    const s = scheduler(() => {
      calls++;
      return UP;
    });

    await s.tick();
    expect(calls).toBe(0);

    repo.setPaused("a", false, clock);
    await s.tick();
    expect(calls).toBe(1);
  });

  it("records a failure when the checker itself throws", async () => {
    add("a", { failureThreshold: 1 });
    const s = scheduler(() => {
      throw new Error("boom");
    });

    await s.tick();
    expect(repo.getMonitor("a")).toMatchObject({ status: "down", lastError: "boom" });
  });

  it("drops the result if the monitor was deleted mid-check", async () => {
    add("a");
    const s = scheduler(() => {
      repo.deleteMonitor("a");
      return UP;
    });

    await s.tick();
    expect(outcomes).toHaveLength(0);
  });
});

describe("claim (the lease)", () => {
  it("never hands the same check to two agents of one region", () => {
    add("a");
    add("b");
    const first = repo.claim("eu-west", clock, 10);
    const second = repo.claim("eu-west", clock, 10);
    expect(first.map((job) => job.monitorId).sort()).toEqual(["a", "b"]);
    expect(second).toEqual([]);
  });

  it("gives every region its own schedule for every monitor", () => {
    add("a");
    expect(repo.claim("eu-west", clock, 10)).toHaveLength(1);
    expect(repo.claim("us-east", clock, 10)).toHaveLength(1);

    clock += 60_000;
    expect(repo.claim("eu-west", clock, 10)).toHaveLength(1);
  });

  it("makes a check due again one interval later even if the agent never reports", () => {
    add("a", { intervalSeconds: 30 });
    expect(repo.claim("eu-west", clock, 10)).toHaveLength(1); // ...and the agent dies
    clock += 29_000;
    expect(repo.claim("eu-west", clock, 10)).toHaveLength(0);
    clock += 1000;
    expect(repo.claim("eu-west", clock, 10)).toHaveLength(1);
  });
});

describe("quorum across regions", () => {
  it("one failing region degrades the monitor but opens no incident", () => {
    add("a", { failureThreshold: 1 });
    report("eu-west", "a", UP);
    report("us-east", "a", UP);
    report("ap-south", "a", DOWN);

    expect(repo.getMonitor("a")).toMatchObject({ status: "degraded", lastError: "HTTP 503" });
    expect(repo.recentIncidents(10)).toHaveLength(0);
  });

  it("a majority opens the incident; losing the majority resolves it", () => {
    add("a", { failureThreshold: 1 });
    report("eu-west", "a", UP);
    report("us-east", "a", DOWN);
    report("ap-south", "a", DOWN);
    expect(repo.getMonitor("a")?.status).toBe("down");
    expect(repo.recentIncidents(10)).toHaveLength(1);

    clock += 60_000;
    report("us-east", "a", UP);
    expect(repo.getMonitor("a")?.status).toBe("degraded");
    expect(repo.recentIncidents(10)[0]?.resolvedAt).toBe(clock);

    report("ap-south", "a", UP);
    expect(repo.getMonitor("a")).toMatchObject({ status: "up", lastError: null });
    expect(outcomes.map((o) => o.event).filter(Boolean)).toEqual(["opened", "resolved"]);
  });

  it("a region that stops reporting stops voting", () => {
    add("a", { intervalSeconds: 60, failureThreshold: 1 });
    report("eu-west", "a", DOWN);
    report("us-east", "a", DOWN);
    report("ap-south", "a", UP);
    expect(repo.getMonitor("a")?.status).toBe("down");

    // eu-west and us-east go silent; only ap-south keeps reporting.
    clock += 4 * 60_000;
    report("ap-south", "a", UP);
    expect(repo.getMonitor("a")?.status).toBe("up");
    expect(repo.regionsOf({ id: "a", intervalSeconds: 60 }, clock)).toMatchObject([
      { region: "ap-south", stale: false },
      { region: "eu-west", stale: true },
      { region: "us-east", stale: true },
    ]);
  });

  it("removing a probe withdraws its votes", () => {
    add("a", { failureThreshold: 1 });
    repo.createProbe("p1", "us-east", "hash-1", clock);
    report("eu-west", "a", UP);
    report("us-east", "a", DOWN);
    expect(repo.getMonitor("a")?.status).toBe("degraded");

    expect(repo.deleteProbe("p1")).toBe(true);
    report("eu-west", "a", UP);
    expect(repo.getMonitor("a")?.status).toBe("up");
  });

  it("rolls every region's checks into the daily stats in the same transaction", () => {
    add("a");
    for (const result of [UP, DOWN, UP, UP]) {
      report("eu-west", "a", result);
      clock += 60_000;
    }

    expect(repo.dailyStats("a", 0)[0]).toMatchObject({ total: 4, up: 3 });
    expect(repo.uptimeSince("a", 0)).toBe(0.75);

    // Trimming raw rows must not change long-range uptime.
    expect(repo.trimChecks(clock)).toBe(4);
    expect(repo.dailyStats("a", 0)[0]).toMatchObject({ total: 4, up: 3 });
  });
});
