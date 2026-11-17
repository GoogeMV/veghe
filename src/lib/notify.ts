import { createHmac, randomUUID } from "node:crypto";
import { assertPublicTarget } from "./net.js";

export interface IncidentNotification {
  event: "incident.opened" | "incident.resolved";
  monitor: { id: string; name: string };
  at: number;
  cause: string | null;
  /** Only on incident.resolved. */
  durationMs?: number;
}

export interface NotifyOptions {
  allowPrivate: boolean;
  /** When set, every delivery is signed so the receiver can check it came from this server. */
  secret?: string | null;
  /** Waits before the second, third, ... attempt. Empty means a single attempt. */
  retryDelaysMs?: number[];
}

const NOTIFY_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000];

function summary(payload: IncidentNotification): string {
  if (payload.event === "incident.opened") {
    return `🔴 ${payload.monitor.name} is down: ${payload.cause ?? "unknown cause"}`;
  }
  const minutes = Math.max(1, Math.round((payload.durationMs ?? 0) / 60_000));
  return `🟢 ${payload.monitor.name} recovered after ${minutes} min`;
}

/**
 * Chat webhooks want their own shape. Detected from the destination host so
 * that "paste the webhook URL" is the whole setup; anything else gets the
 * full JSON payload.
 */
export function bodyFor(webhookUrl: string, payload: IncidentNotification): unknown {
  const host = new URL(webhookUrl).hostname;
  if (host === "hooks.slack.com") return { text: summary(payload) };
  if (host === "discord.com" || host === "discordapp.com") return { content: summary(payload) };
  return payload;
}

/**
 * HMAC-SHA256 over "<timestamp>.<body>". The timestamp is inside the signed
 * string so a captured delivery cannot be replayed later with a fresh one;
 * receivers should also reject timestamps more than a few minutes old.
 */
export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delivers one incident notification, retrying on network errors, 5xx and
 * 429. A 4xx means the receiver understood and refused, so it is not
 * retried. Every attempt carries the same x-veghe-delivery id, which lets a
 * receiver that got the first attempt but answered too slowly ignore the
 * repeat.
 *
 * Retries live in memory: a restart between attempts loses the notification.
 * The incident itself is always in the database.
 */
export async function notify(
  webhookUrl: string,
  payload: IncidentNotification,
  opts: NotifyOptions,
): Promise<"sent" | "failed"> {
  try {
    await assertPublicTarget(webhookUrl, opts.allowPrivate);
  } catch {
    return "failed"; // not a destination we will send to; retrying cannot change that
  }

  const body = JSON.stringify(bodyFor(webhookUrl, payload));
  const delivery = randomUUID();
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1] ?? 0);

    // Signed per attempt, so the timestamp is fresh on a retry.
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "user-agent": "veghe/2.0 (uptime monitor)",
          "x-veghe-delivery": delivery,
          "x-veghe-timestamp": String(timestamp),
          ...(opts.secret && {
            "x-veghe-signature": `sha256=${sign(opts.secret, timestamp, body)}`,
          }),
        },
        body,
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return "sent";
      if (res.status < 500 && res.status !== 429) return "failed";
    } catch {
      // network error or timeout: fall through to the next attempt
    }
  }
  return "failed";
}
