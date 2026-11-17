import type { Status } from "./state.js";

export type BusEvent =
  | {
      type: "check";
      monitorId: string;
      region: string;
      at: number;
      ok: boolean;
      latencyMs: number | null;
      status: Status;
    }
  | { type: "incident"; event: "opened" | "resolved"; monitorId: string; at: number }
  | { type: "monitors" };

type Listener = (event: BusEvent) => void;

/**
 * In-process fan-out from recorded results to SSE clients. This is the
 * single-node seam: running several instances would mean swapping this for
 * Redis pub/sub or Postgres LISTEN/NOTIFY, and nothing else.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: BusEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
