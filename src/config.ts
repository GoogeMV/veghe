export interface Config {
  host: string;
  port: number;
  dbPath: string;
  logLevel: string;
  /** Bearer token guarding every write endpoint. */
  adminToken: string;
  /** When false (default), monitors and webhooks may not target private or loopback addresses. */
  allowPrivateTargets: boolean;
  /** Run the built-in probe inside the server process. */
  localProbe: boolean;
  /** Region name the built-in probe votes as. */
  localRegion: string;
  /** Probes declared in configuration (PROBE_TOKENS=region:token,region:token). */
  probeTokens: { region: string; token: string }[];
  /** Signs outgoing webhooks when set. */
  webhookSecret: string | null;
  /** How often monitors are re-evaluated for regions that went silent. */
  sweepMs: number;
  /** How often the scheduler looks for due monitors. */
  schedulerTickMs: number;
  /** Upper bound on checks in flight at once. */
  checkConcurrency: number;
  /** Raw check rows older than this are trimmed; daily rollups are kept. */
  rawRetentionDays: number;
  rateLimit: {
    globalMax: number;
    windowMs: number;
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function probeTokensFromEnv(): { region: string; token: string }[] {
  const raw = process.env.PROBE_TOKENS ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const split = entry.indexOf(":");
      const region = entry.slice(0, split);
      const token = entry.slice(split + 1);
      if (split < 1 || !REGION_PATTERN.test(region) || token.length < 16) {
        throw new Error(
          "PROBE_TOKENS entries must look like region:token, with a token of at least 16 characters",
        );
      }
      return { region, token };
    });
}

function webhookSecretFromEnv(): string | null {
  const secret = process.env.WEBHOOK_SECRET ?? "";
  if (secret === "") return null;
  if (secret.length < 16) throw new Error("WEBHOOK_SECRET must be at least 16 characters");
  return secret;
}

export function loadConfig(): Config {
  const adminToken = process.env.ADMIN_TOKEN ?? "";
  if (adminToken.length < 16) {
    throw new Error("ADMIN_TOKEN is required and must be at least 16 characters");
  }
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: intFromEnv("PORT", 8083),
    dbPath: process.env.DB_PATH ?? "data/veghe.db",
    logLevel: process.env.LOG_LEVEL ?? "info",
    adminToken,
    allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === "true",
    localProbe: process.env.LOCAL_PROBE !== "false",
    localRegion: process.env.LOCAL_REGION ?? "local",
    probeTokens: probeTokensFromEnv(),
    webhookSecret: webhookSecretFromEnv(),
    sweepMs: intFromEnv("SWEEP_MS", 30_000),
    schedulerTickMs: intFromEnv("SCHEDULER_TICK_MS", 1000),
    checkConcurrency: intFromEnv("CHECK_CONCURRENCY", 10),
    rawRetentionDays: intFromEnv("RAW_RETENTION_DAYS", 7),
    rateLimit: {
      globalMax: intFromEnv("RATE_LIMIT_GLOBAL_MAX", 600),
      windowMs: intFromEnv("RATE_LIMIT_WINDOW_MS", 60_000),
    },
  };
}
