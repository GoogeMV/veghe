/** What one region thinks of a monitor. */
export type RegionStatus = "pending" | "up" | "down";

/** What veghe as a whole says about a monitor. */
export type Status = RegionStatus | "degraded";

export interface RegionState {
  status: RegionStatus;
  consecutiveFailures: number;
}

export type IncidentEvent = "opened" | "resolved" | null;

/**
 * Per-region flap damping, as a pure function.
 *
 * A region only reports "down" after `failureThreshold` consecutive failed
 * checks, so one dropped packet does not count as a vote. Recovery is
 * immediate: a single successful check flips it back.
 */
export function transition(state: RegionState, ok: boolean, failureThreshold: number): RegionState {
  if (ok) return { status: "up", consecutiveFailures: 0 };

  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= failureThreshold) return { status: "down", consecutiveFailures };
  return { status: state.status, consecutiveFailures };
}

/**
 * Quorum across regions, as a pure function.
 *
 * Takes the verdicts of every region with a fresh opinion and returns the
 * monitor's status: "down" only when a strict majority says so, "degraded"
 * when a minority does. A single probe with a broken network path therefore
 * cannot open an incident on its own (unless it is the only probe there is).
 *
 * `known` is how many regions have ever voted on this monitor, including
 * ones that are currently silent. It guards the moment after a restart or a
 * network split, when the first probe to report would otherwise be the whole
 * electorate: while two or more regions are known, at least two fresh votes
 * are needed for "down". Recovery needs no such guard.
 *
 * Returns null when no region has an opinion yet; the caller keeps the
 * previous status.
 */
export function aggregate(
  regions: RegionStatus[],
  known?: number,
): Exclude<Status, "pending"> | null {
  const voting = regions.filter((status) => status !== "pending");
  if (voting.length === 0) return null;

  const down = voting.filter((status) => status === "down").length;
  // With several regions known, one voice is never enough to declare an
  // outage, even when it is the only one currently speaking.
  const quorum = Math.min(2, known ?? voting.length);
  if (down * 2 > voting.length && voting.length >= quorum) return "down";
  return down > 0 ? "degraded" : "up";
}

export function incidentEvent(before: Status, after: Status): IncidentEvent {
  if (after === "down" && before !== "down") return "opened";
  if (before === "down" && after !== "down") return "resolved";
  return null;
}
