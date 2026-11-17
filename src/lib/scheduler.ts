import type { Job, MonitorRepository, Outcome } from "../db.js";
import type { Checker, CheckResult } from "./checker.js";

export interface SchedulerOptions {
  repo: MonitorRepository;
  /** The region this in-process probe votes as. */
  region: string;
  check: Checker;
  concurrency: number;
  onResult: (outcome: Outcome) => void;
  onError?: (err: unknown) => void;
  now?: () => number;
}

/**
 * The built-in probe: the same claim/record cycle a remote agent runs over
 * HTTP, done in-process against the repository. It is what makes veghe work
 * as a single binary with no agents at all.
 *
 * The schedule lives in the database (`next_check_at` per monitor and
 * region), not in timers, so a restart loses nothing. The next run is booked
 * when a check is claimed, not when it finishes, so a slow target does not
 * make its own schedule drift.
 */
export class Scheduler {
  private readonly now: () => number;
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(tickMs: number): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.opts.onError?.(err));
    }, tickMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): number {
    return this.inFlight;
  }

  /** Claims as many due checks as there are free slots; resolves when they are recorded. */
  async tick(): Promise<void> {
    const free = this.opts.concurrency - this.inFlight;
    if (free <= 0 || this.stopped) return;

    const now = this.now();
    const jobs = this.opts.repo.claim(this.opts.region, now, free);
    await Promise.all(jobs.map((job) => this.run(job, now)));
  }

  private async run(job: Job, now: number): Promise<void> {
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

    // The database may already be closed if we were stopped mid-check.
    if (this.stopped) return;
    const outcome = this.opts.repo.recordResult(job.monitorId, this.opts.region, result, now);
    if (outcome) this.opts.onResult(outcome);
  }
}
