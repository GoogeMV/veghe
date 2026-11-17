/**
 * Demo data: a few monitors plus 89 days of SYNTHETIC history, so the status
 * page has something to show before real checks have accumulated. Everything
 * before "today" in a seeded database is made up; real checks take over from
 * the moment the server starts.
 *
 *   npm run seed          # refuses if monitors already exist
 */
import { DAY_MS, dayOf, MonitorRepository } from "../src/db.js";
import { newMonitorId } from "../src/lib/ids.js";

const dbPath = process.env.DB_PATH ?? "data/veghe.db";
const port = process.env.PORT ?? "8083";
const region = process.env.LOCAL_REGION ?? "local";
const repo = new MonitorRepository(dbPath);

if (repo.listMonitors().length > 0) {
  console.error(`${dbPath} already has monitors; delete the file to reseed.`);
  process.exit(1);
}

// Small seeded PRNG (mulberry32) so every seed produces the same page.
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Demo {
  name: string;
  url: string;
  latencyMs: number;
  /** days ago -> minutes of downtime that day */
  outages: Record<number, number>;
  cause: string;
}

const demos: Demo[] = [
  {
    name: "veghe (self)",
    url: `http://localhost:${port}/healthz`,
    latencyMs: 4,
    outages: {},
    cause: "",
  },
  {
    name: "example.com",
    url: "https://example.com/",
    latencyMs: 180,
    outages: { 61: 14, 23: 3 },
    cause: "timeout after 5000ms",
  },
  {
    name: "Wikipedia certificate",
    url: "tls://www.wikipedia.org",
    latencyMs: 90,
    outages: { 47: 95 },
    cause: "certificate expires in 13 days",
  },
  {
    name: "Public DNS (TCP 53)",
    url: "tcp://1.1.1.1:53",
    latencyMs: 20,
    outages: { 12: 6 },
    cause: "timeout after 5000ms",
  },
  {
    name: "Legacy API (always down)",
    url: "http://127.0.0.1:65500/", // nothing listens here
    latencyMs: 60,
    outages: { 70: 240, 34: 31, 5: 1440, 4: 1440, 3: 1440, 2: 1440, 1: 1440 },
    cause: "ECONNREFUSED",
  },
];

const now = Date.now();
const today = dayOf(now);
const random = prng(2026);
const CHECKS_PER_DAY = 1440; // one per minute

for (const [index, demo] of demos.entries()) {
  const monitor = repo.createMonitor(
    {
      id: newMonitorId(),
      name: demo.name,
      url: demo.url,
      intervalSeconds: 30,
      timeoutMs: 5000,
      failureThreshold: 2,
      keyword: null,
      webhookUrl: null,
    },
    now + index, // distinct creation times keep the listed order stable
  );

  for (let daysAgo = 89; daysAgo >= 1; daysAgo--) {
    const failed = Math.min(demo.outages[daysAgo] ?? 0, CHECKS_PER_DAY);
    const up = CHECKS_PER_DAY - failed;
    const latency = Math.round(demo.latencyMs * (0.85 + random() * 0.3));
    let total = CHECKS_PER_DAY;

    // One incident per outage day; a run of full-day outages is one long incident.
    const continuesFromYesterday = (demo.outages[daysAgo + 1] ?? 0) >= CHECKS_PER_DAY;
    if (failed > 0 && !continuesFromYesterday) {
      const dayStart = (today - daysAgo) * DAY_MS;
      let lengthMin = failed;
      for (let d = daysAgo - 1; d >= 1 && (demo.outages[d] ?? 0) >= CHECKS_PER_DAY; d--) {
        lengthMin += CHECKS_PER_DAY;
      }
      const startedAt =
        failed >= CHECKS_PER_DAY ? dayStart : dayStart + Math.floor(random() * 20) * 3_600_000;
      const resolvedAt = startedAt + lengthMin * 60_000;

      if (resolvedAt < today * DAY_MS) {
        repo.openIncident(monitor.id, startedAt, demo.cause, resolvedAt);
      } else {
        // Still ongoing: open it through the real state machine, so the
        // monitor is genuinely "down" and the live probes continue the same
        // incident instead of opening a second one.
        const failure = { ok: false, statusCode: null, latencyMs: null, error: demo.cause };
        repo.claim(region, startedAt, 1000);
        for (let i = 0; i < monitor.failureThreshold; i++) {
          repo.recordResult(monitor.id, region, failure, startedAt);
        }
        total -= monitor.failureThreshold; // those checks counted themselves
      }
    }
    repo.addDailyStats(monitor.id, today - daysAgo, total, up, up * latency);
  }
  console.log(`seeded ${demo.name}`);
}

repo.close();
console.log(`done: ${demos.length} monitors in ${dbPath} (history before today is synthetic)`);
