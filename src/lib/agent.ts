import type { Job } from "../db.js";
import type { Checker, CheckResult } from "./checker.js";

export interface AgentOptions {
  /** Origin of the veghe server, e.g. https://status.example.com */
  serverUrl: string;
  /** Probe token; the server maps it to this agent's region. */
  token: string;
  check: Checker;
  concurrency: number;
  onError?: (err: unknown) => void;
}

/**
 * A remote probe. It holds no state and no schedule: each tick it asks the
 * server "what is due for my region?", runs those checks from wherever it
 * is deployed, and posts the results back. Agents only make outbound
 * requests, so they run behind NAT with no inbound port.
 */
export class Agent {
  private readonly base: string;
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly opts: AgentOptions) {
    this.base = opts.serverUrl.replace(/\/+$/, "");
  }

  start(pollMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // One claim request at a time; checks themselves overlap freely.
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .catch((err) => this.opts.onError?.(err))
        .finally(() => {
          this.busy = false;
        });
    }, pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Claims due checks, runs them and reports each as it finishes. */
  async tick(): Promise<number> {
    const free = this.opts.concurrency - this.inFlight;
    if (free <= 0) return 0;

    const { jobs } = await this.post<{ jobs: Job[] }>("/api/probe/claim", { limit: free });
    await Promise.all(jobs.map((job) => this.run(job)));
    return jobs.length;
  }

  private async run(job: Job): Promise<void> {
    this.inFlight++;
    let result: CheckResult;
    try {
      result = await this.opts.check(job);
    } catch (err) {
      result = {
        ok: false,
        statusCode: null,
        latencyMs: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.inFlight--;
    }
    // A lost report is not retried: the check is due again one interval
    // later, and a late result would be a stale vote.
    await this.post("/api/probe/results", {
      results: [{ monitorId: job.monitorId, ...result }],
    }).catch((err) => this.opts.onError?.(err));
  }
}
