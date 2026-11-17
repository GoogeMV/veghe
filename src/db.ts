import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CheckResult, CheckTarget } from "./lib/checker.js";
import {
  aggregate,
  type IncidentEvent,
  incidentEvent,
  type RegionStatus,
  type Status,
  transition,
} from "./lib/state.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  failure_threshold INTEGER NOT NULL,
  keyword TEXT,
  webhook_url TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_checked_at INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

-- One row per (monitor, region): that region's schedule and its current vote.
CREATE TABLE IF NOT EXISTS monitor_regions (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  PRIMARY KEY (monitor_id, region)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS monitor_regions_due ON monitor_regions (region, next_check_at);

CREATE TABLE IF NOT EXISTS probes (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS checks_monitor_at ON checks (monitor_id, at);

-- One row per monitor per UTC day, updated in the same transaction as the
-- check insert. Long-range uptime reads this, so raw checks can be trimmed.
CREATE TABLE IF NOT EXISTS daily_stats (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  total INTEGER NOT NULL,
  up INTEGER NOT NULL,
  latency_sum INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  cause TEXT
);
CREATE INDEX IF NOT EXISTS incidents_monitor ON incidents (monitor_id, started_at);
`;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day number: days since the Unix epoch. */
export function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * A region's vote counts only while it is recent: within three check
 * intervals (and never less than 90s). A probe that dies stops voting
 * instead of holding its last opinion forever.
 */
export function freshnessWindowMs(intervalSeconds: number): number {
  return Math.max(3 * intervalSeconds * 1000, 90_000);
}

export interface Monitor {
  id: string;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  keyword: string | null;
  webhookUrl: string | null;
  paused: boolean;
  status: Status;
  lastCheckedAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface NewMonitor {
  id: string;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  keyword: string | null;
  webhookUrl: string | null;
}

export interface RegionView {
  region: string;
  status: RegionStatus;
  /** True when this region's last check is too old to count towards quorum. */
  stale: boolean;
  lastCheckedAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
}

/** One unit of work handed to a probe. */
export interface Job extends CheckTarget {
  monitorId: string;
}

export interface Probe {
  id: string;
  region: string;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface Check {
  region: string;
  at: number;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface DayStat {
  day: number;
  total: number;
  up: number;
}

export interface Incident {
  id: number;
  monitorId: string;
  monitorName: string;
  startedAt: number;
  resolvedAt: number | null;
  cause: string | null;
}

/** A monitor's status changing without a new check, because a region went silent. */
export interface StatusChange {
  monitor: Monitor;
  at: number;
  event: IncidentEvent;
  cause: string | null;
  incidentStartedAt: number | null;
}

/** What recording one check result changed. */
export interface Outcome {
  monitor: Monitor;
  check: Check;
  event: IncidentEvent;
  /** Why the monitor is down; set when `event` is "opened". */
  cause: string | null;
  /** When the incident that just closed began; set when `event` is "resolved". */
  incidentStartedAt: number | null;
}

interface MonitorRow {
  id: string;
  name: string;
  url: string;
  interval_seconds: number;
  timeout_ms: number;
  failure_threshold: number;
  keyword: string | null;
  webhook_url: string | null;
  paused: number;
  status: Status;
  last_checked_at: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
  created_at: number;
}

interface RegionRow {
  region: string;
  status: RegionStatus;
  consecutive_failures: number;
  last_checked_at: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
}

function toMonitor(row: MonitorRow): Monitor {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    failureThreshold: row.failure_threshold,
    keyword: row.keyword,
    webhookUrl: row.webhook_url,
    paused: row.paused === 1,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastLatencyMs: row.last_latency_ms,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export class MonitorRepository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- monitors ----

  createMonitor(input: NewMonitor, now: number): Monitor {
    this.db
      .prepare(
        `INSERT INTO monitors
           (id, name, url, interval_seconds, timeout_ms, failure_threshold, keyword, webhook_url,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.url,
        input.intervalSeconds,
        input.timeoutMs,
        input.failureThreshold,
        input.keyword,
        input.webhookUrl,
        now,
      );
    return this.getMonitor(input.id) as Monitor;
  }

  getMonitor(id: string): Monitor | null {
    const row = this.db.prepare("SELECT * FROM monitors WHERE id = ?").get(id) as
      | MonitorRow
      | undefined;
    return row ? toMonitor(row) : null;
  }

  listMonitors(): Monitor[] {
    const rows = this.db
      .prepare("SELECT * FROM monitors ORDER BY created_at, id")
      .all() as MonitorRow[];
    return rows.map(toMonitor);
  }

  deleteMonitor(id: string): boolean {
    return this.db.prepare("DELETE FROM monitors WHERE id = ?").run(id).changes > 0;
  }

  /** Resuming makes the monitor due everywhere right away. */
  setPaused(id: string, paused: boolean, now: number): boolean {
    const tx = this.db.transaction(() => {
      const changed =
        this.db.prepare("UPDATE monitors SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id)
          .changes > 0;
      if (changed) this.makeDue(id, now);
      return changed;
    });
    return tx();
  }

  makeDue(monitorId: string, now: number): void {
    this.db
      .prepare("UPDATE monitor_regions SET next_check_at = ? WHERE monitor_id = ?")
      .run(now, monitorId);
  }

  // ---- scheduling ----

  /**
   * Hands a region its due checks and books each one's next run, atomically.
   *
   * This is the lease: because the claim and the reschedule are one
   * transaction, two agents sharing a region can never be handed the same
   * check. If an agent dies after claiming, nothing needs cleaning up: the
   * check is simply due again one interval later.
   */
  claim(region: string, now: number, limit: number): Job[] {
    const tx = this.db.transaction((): Job[] => {
      // A region sees every monitor; new pairings are due immediately.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO monitor_regions (monitor_id, region, next_check_at)
           SELECT id, ?, ? FROM monitors`,
        )
        .run(region, now);

      const due = this.db
        .prepare(
          `SELECT m.id, m.url, m.timeout_ms, m.keyword, m.interval_seconds
           FROM monitor_regions r JOIN monitors m ON m.id = r.monitor_id
           WHERE r.region = ? AND r.next_check_at <= ? AND m.paused = 0
           ORDER BY r.next_check_at LIMIT ?`,
        )
        .all(region, now, limit) as {
        id: string;
        url: string;
        timeout_ms: number;
        keyword: string | null;
        interval_seconds: number;
      }[];

      const book = this.db.prepare(
        "UPDATE monitor_regions SET next_check_at = ? WHERE monitor_id = ? AND region = ?",
      );
      for (const row of due) book.run(now + row.interval_seconds * 1000, row.id, region);

      return due.map((row) => ({
        monitorId: row.id,
        url: row.url,
        timeoutMs: row.timeout_ms,
        keyword: row.keyword,
      }));
    });
    return tx();
  }

  /**
   * Applies one region's check result atomically: raw row, daily rollup,
   * the region's vote, the monitor's quorum status and incident open/close
   * either all land or none do. Returns null if the monitor (or the region's
   * pairing with it) no longer exists.
   */
  recordResult(monitorId: string, region: string, result: CheckResult, at: number): Outcome | null {
    const tx = this.db.transaction((): Outcome | null => {
      const before = this.getMonitor(monitorId);
      const row = this.db
        .prepare(
          "SELECT status, consecutive_failures FROM monitor_regions WHERE monitor_id = ? AND region = ?",
        )
        .get(monitorId, region) as
        | { status: RegionStatus; consecutive_failures: number }
        | undefined;
      if (!before || !row) return null;

      const vote = transition(
        { status: row.status, consecutiveFailures: row.consecutive_failures },
        result.ok,
        before.failureThreshold,
      );
      this.db
        .prepare(
          `UPDATE monitor_regions
           SET status = ?, consecutive_failures = ?, last_checked_at = ?, last_latency_ms = ?,
               last_error = ?
           WHERE monitor_id = ? AND region = ?`,
        )
        .run(
          vote.status,
          vote.consecutiveFailures,
          at,
          result.latencyMs,
          result.error,
          monitorId,
          region,
        );

      this.db
        .prepare(
          "INSERT INTO checks (monitor_id, region, at, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          monitorId,
          region,
          at,
          result.ok ? 1 : 0,
          result.statusCode,
          result.latencyMs,
          result.error,
        );
      this.addDailyStats(monitorId, dayOf(at), 1, result.ok ? 1 : 0, result.latencyMs ?? 0);

      const regions = this.regionsOf(before, at);
      const voting = regions.filter((r) => !r.stale);
      const known = regions.filter((r) => r.status !== "pending").length;
      const status =
        aggregate(
          voting.map((r) => r.status),
          known,
        ) ?? before.status;
      const event = incidentEvent(before.status, status);
      const downRegion = voting.find((r) => r.status === "down");
      const cause =
        status === "up" ? null : (result.error ?? downRegion?.lastError ?? before.lastError);

      this.db
        .prepare(
          "UPDATE monitors SET status = ?, last_checked_at = ?, last_latency_ms = ?, last_error = ? WHERE id = ?",
        )
        .run(status, at, result.latencyMs ?? before.lastLatencyMs, cause, monitorId);

      const incidentStartedAt = this.applyIncident(monitorId, event, at, cause);

      return {
        monitor: this.getMonitor(monitorId) as Monitor,
        check: {
          region,
          at,
          ok: result.ok,
          statusCode: result.statusCode,
          latencyMs: result.latencyMs,
          error: result.error,
        },
        event,
        cause: event === "opened" ? cause : null,
        incidentStartedAt,
      };
    });
    return tx();
  }

  /** Opens or closes the monitor's incident; returns when a just-closed one began. */
  private applyIncident(
    monitorId: string,
    event: IncidentEvent,
    at: number,
    cause: string | null,
  ): number | null {
    if (event === "opened") {
      this.openIncident(monitorId, at, cause);
      return null;
    }
    if (event !== "resolved") return null;
    const open = this.db
      .prepare(
        "SELECT id, started_at FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(monitorId) as { id: number; started_at: number } | undefined;
    if (!open) return null;
    this.db.prepare("UPDATE incidents SET resolved_at = ? WHERE id = ?").run(at, open.id);
    return open.started_at;
  }

  /**
   * Re-derives a monitor's status from the votes that are still fresh.
   *
   * recordResult only runs when a result arrives, so on its own a region
   * going silent would be noticed only at the next result from some other
   * region, and never if every probe died at once. The sweeper calls this
   * on a timer. Returns null when nothing changed.
   */
  reevaluate(monitorId: string, at: number): StatusChange | null {
    const tx = this.db.transaction((): StatusChange | null => {
      const before = this.getMonitor(monitorId);
      if (!before || before.paused) return null;

      const regions = this.regionsOf(before, at);
      const voting = regions.filter((r) => !r.stale);
      const status = aggregate(
        voting.map((r) => r.status),
        regions.filter((r) => r.status !== "pending").length,
      );
      // No fresh votes at all is "we do not know", not "up" or "down":
      // the last known status stands until a probe reports again.
      if (status === null || status === before.status) return null;

      const event = incidentEvent(before.status, status);
      const cause =
        status === "up"
          ? null
          : (voting.find((r) => r.status === "down")?.lastError ?? before.lastError);
      this.db
        .prepare("UPDATE monitors SET status = ?, last_error = ? WHERE id = ?")
        .run(status, cause, monitorId);
      const incidentStartedAt = this.applyIncident(monitorId, event, at, cause);

      return {
        monitor: this.getMonitor(monitorId) as Monitor,
        at,
        event,
        cause: event === "opened" ? cause : null,
        incidentStartedAt,
      };
    });
    return tx();
  }

  regionsOf(monitor: Pick<Monitor, "id" | "intervalSeconds">, now: number): RegionView[] {
    const rows = this.db
      .prepare(
        `SELECT region, status, consecutive_failures, last_checked_at, last_latency_ms, last_error
         FROM monitor_regions WHERE monitor_id = ? ORDER BY region`,
      )
      .all(monitor.id) as RegionRow[];
    const oldest = now - freshnessWindowMs(monitor.intervalSeconds);
    return rows.map((row) => ({
      region: row.region,
      status: row.status,
      stale: row.last_checked_at === null || row.last_checked_at < oldest,
      lastCheckedAt: row.last_checked_at,
      lastLatencyMs: row.last_latency_ms,
      lastError: row.last_error,
    }));
  }

  // ---- probes ----

  /** Throws on a duplicate region or token (UNIQUE constraints). */
  createProbe(id: string, region: string, tokenHash: string, now: number): Probe {
    this.db
      .prepare("INSERT INTO probes (id, region, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, region, tokenHash, now);
    return { id, region, createdAt: now, lastSeenAt: null };
  }

  /** For probes declared in configuration: create, or rotate the token of an existing region. */
  upsertProbe(id: string, region: string, tokenHash: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO probes (id, region, token_hash, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (region) DO UPDATE SET token_hash = excluded.token_hash`,
      )
      .run(id, region, tokenHash, now);
  }

  /** Looks a probe up by token hash and stamps it as seen. */
  authenticateProbe(tokenHash: string, now: number): Probe | null {
    const row = this.db
      .prepare(
        "UPDATE probes SET last_seen_at = ? WHERE token_hash = ? RETURNING id, region, created_at, last_seen_at",
      )
      .get(now, tokenHash) as
      | { id: string; region: string; created_at: number; last_seen_at: number | null }
      | undefined;
    return row
      ? { id: row.id, region: row.region, createdAt: row.created_at, lastSeenAt: row.last_seen_at }
      : null;
  }

  listProbes(): Probe[] {
    const rows = this.db
      .prepare("SELECT id, region, created_at, last_seen_at FROM probes ORDER BY region")
      .all() as { id: string; region: string; created_at: number; last_seen_at: number | null }[];
    return rows.map((row) => ({
      id: row.id,
      region: row.region,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  /** Removing a probe also withdraws its region's votes. */
  deleteProbe(id: string): boolean {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("DELETE FROM probes WHERE id = ? RETURNING region").get(id) as
        | { region: string }
        | undefined;
      if (!row) return false;
      this.db.prepare("DELETE FROM monitor_regions WHERE region = ?").run(row.region);
      return true;
    });
    return tx();
  }

  // ---- history ----

  addDailyStats(monitorId: string, day: number, total: number, up: number, latencySum: number) {
    this.db
      .prepare(
        `INSERT INTO daily_stats (monitor_id, day, total, up, latency_sum) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (monitor_id, day) DO UPDATE SET
           total = total + excluded.total,
           up = up + excluded.up,
           latency_sum = latency_sum + excluded.latency_sum`,
      )
      .run(monitorId, day, total, up, latencySum);
  }

  openIncident(
    monitorId: string,
    startedAt: number,
    cause: string | null,
    resolvedAt: number | null = null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO incidents (monitor_id, started_at, resolved_at, cause) VALUES (?, ?, ?, ?)",
      )
      .run(monitorId, startedAt, resolvedAt, cause);
  }

  /** Newest first. */
  recentChecks(monitorId: string, limit: number): Check[] {
    const rows = this.db
      .prepare(
        "SELECT region, at, ok, status_code, latency_ms, error FROM checks WHERE monitor_id = ? ORDER BY at DESC, id DESC LIMIT ?",
      )
      .all(monitorId, limit) as {
      region: string;
      at: number;
      ok: number;
      status_code: number | null;
      latency_ms: number | null;
      error: string | null;
    }[];
    return rows.map((row) => ({
      region: row.region,
      at: row.at,
      ok: row.ok === 1,
      statusCode: row.status_code,
      latencyMs: row.latency_ms,
      error: row.error,
    }));
  }

  /** Uptime over raw checks since `since`, or null when there are none. */
  uptimeSince(monitorId: string, since: number): number | null {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS up FROM checks WHERE monitor_id = ? AND at >= ?",
      )
      .get(monitorId, since) as { total: number; up: number };
    return row.total === 0 ? null : row.up / row.total;
  }

  dailyStats(monitorId: string, sinceDay: number): DayStat[] {
    return this.db
      .prepare(
        "SELECT day, total, up FROM daily_stats WHERE monitor_id = ? AND day >= ? ORDER BY day",
      )
      .all(monitorId, sinceDay) as DayStat[];
  }

  incidentsFor(monitorId: string, limit: number) {
    return this.db
      .prepare(
        `SELECT id, started_at AS startedAt, resolved_at AS resolvedAt, cause
         FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(monitorId, limit) as {
      id: number;
      startedAt: number;
      resolvedAt: number | null;
      cause: string | null;
    }[];
  }

  /** Per-region figures over raw checks since `since`: volume, uptime, mean and p95 latency. */
  regionStats(monitorId: string, since: number) {
    const rows = this.db
      .prepare(
        "SELECT region, ok, latency_ms AS ms FROM checks WHERE monitor_id = ? AND at >= ? ORDER BY region, latency_ms",
      )
      .all(monitorId, since) as { region: string; ok: number; ms: number | null }[];

    const byRegion = new Map<string, { checks: number; up: number; latencies: number[] }>();
    for (const row of rows) {
      let entry = byRegion.get(row.region);
      if (!entry) {
        entry = { checks: 0, up: 0, latencies: [] };
        byRegion.set(row.region, entry);
      }
      entry.checks++;
      entry.up += row.ok;
      if (row.ms !== null) entry.latencies.push(row.ms); // already ascending
    }
    return [...byRegion].map(([region, e]) => ({
      region,
      checks: e.checks,
      uptime: e.up / e.checks,
      meanMs:
        e.latencies.length === 0
          ? null
          : Math.round(e.latencies.reduce((sum, ms) => sum + ms, 0) / e.latencies.length),
      p95Ms:
        e.latencies[Math.min(e.latencies.length - 1, Math.floor(e.latencies.length * 0.95))] ??
        null,
    }));
  }

  recentIncidents(limit: number): Incident[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.monitor_id, m.name AS monitor_name, i.started_at, i.resolved_at, i.cause
         FROM incidents i JOIN monitors m ON m.id = i.monitor_id
         ORDER BY i.started_at DESC, i.id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      monitor_id: string;
      monitor_name: string;
      started_at: number;
      resolved_at: number | null;
      cause: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      monitorId: row.monitor_id,
      monitorName: row.monitor_name,
      startedAt: row.started_at,
      resolvedAt: row.resolved_at,
      cause: row.cause,
    }));
  }

  trimChecks(olderThan: number): number {
    return this.db.prepare("DELETE FROM checks WHERE at < ?").run(olderThan).changes;
  }
}
