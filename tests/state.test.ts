import { describe, expect, it } from "vitest";
import { certificateProblem } from "../src/lib/checker.js";
import {
  assertPublicTarget,
  isPrivateAddress,
  parseHttpUrl,
  parseTarget,
  TargetError,
} from "../src/lib/net.js";
import { bodyFor } from "../src/lib/notify.js";
import { aggregate, incidentEvent, type RegionState, transition } from "../src/lib/state.js";

describe("transition (one region's vote)", () => {
  it("votes up on a successful check and resets the failure streak", () => {
    expect(transition({ status: "down", consecutiveFailures: 7 }, true, 2)).toEqual({
      status: "up",
      consecutiveFailures: 0,
    });
  });

  it("keeps its vote while failures stay below the threshold", () => {
    expect(transition({ status: "up", consecutiveFailures: 0 }, false, 2)).toEqual({
      status: "up",
      consecutiveFailures: 1,
    });
  });

  it("votes down once the threshold is reached, also from pending", () => {
    expect(transition({ status: "up", consecutiveFailures: 1 }, false, 2).status).toBe("down");
    expect(transition({ status: "pending", consecutiveFailures: 0 }, false, 1).status).toBe("down");
  });

  it("flapping never reaches the threshold", () => {
    let state: RegionState = { status: "up", consecutiveFailures: 0 };
    for (const ok of [false, true, false, true, false]) {
      state = transition(state, ok, 2);
      expect(state.status).toBe("up");
    }
  });
});

describe("aggregate (quorum across regions)", () => {
  it.each([
    [["up", "up", "up"], "up"],
    [["down", "up", "up"], "degraded"],
    [["down", "down", "up"], "down"],
    [["down", "down", "down"], "down"],
    [["down", "up"], "degraded"], // a tie is not a majority
    [["down"], "down"], // a lone probe decides alone
    [["up"], "up"],
    [["down", "pending", "pending"], "down"], // pending regions do not vote
    [["up", "pending"], "up"],
  ] as const)("%j -> %s", (regions, expected) => {
    expect(aggregate([...regions])).toBe(expected);
  });

  it("needs two fresh votes for down once more than one region is known", () => {
    expect(aggregate(["down"], 3)).toBe("degraded");
    expect(aggregate(["down", "down"], 3)).toBe("down");
    expect(aggregate(["down"], 1)).toBe("down");
    expect(aggregate(["up"], 3)).toBe("up"); // recovery is not guarded
  });

  it("has no opinion until some region has one", () => {
    expect(aggregate([])).toBeNull();
    expect(aggregate(["pending", "pending"])).toBeNull();
  });
});

describe("incidentEvent", () => {
  it("opens only on entering down and resolves only on leaving it", () => {
    expect(incidentEvent("up", "down")).toBe("opened");
    expect(incidentEvent("degraded", "down")).toBe("opened");
    expect(incidentEvent("pending", "down")).toBe("opened");
    expect(incidentEvent("down", "down")).toBeNull();
    expect(incidentEvent("down", "degraded")).toBe("resolved");
    expect(incidentEvent("down", "up")).toBe("resolved");
    expect(incidentEvent("up", "degraded")).toBeNull();
  });
});

describe("targets", () => {
  it("picks the check kind from the scheme", () => {
    expect(parseTarget("https://example.com/health")).toMatchObject({
      kind: "http",
      host: "example.com",
      port: 443,
    });
    expect(parseTarget("tcp://db.internal:5432")).toMatchObject({
      kind: "tcp",
      host: "db.internal",
      port: 5432,
    });
    expect(parseTarget("tls://example.com")).toMatchObject({ kind: "tls", port: 443 });
    expect(parseTarget("tls://[::1]:8443")).toMatchObject({ kind: "tls", host: "::1", port: 8443 });
  });

  it("rejects unsupported schemes, missing ports and embedded credentials", () => {
    for (const bad of [
      "file:///etc/passwd",
      "ftp://example.com",
      "tcp://example.com",
      "https://user:pw@example.com",
      "nonsense",
    ]) {
      expect(() => parseTarget(bad)).toThrow(TargetError);
    }
    expect(() => parseHttpUrl("tcp://example.com:80")).toThrow(TargetError);
  });
});

describe("SSRF guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.10",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "not-an-ip",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"])(
    "treats %s as public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it("refuses loopback targets of every kind unless private targets are allowed", async () => {
    for (const target of ["http://127.0.0.1:8080/", "http://[::1]/", "tcp://127.0.0.1:5432"]) {
      await expect(assertPublicTarget(target, false)).rejects.toThrow(TargetError);
    }
    await expect(assertPublicTarget("tcp://127.0.0.1:5432", true)).resolves.toMatchObject({
      kind: "tcp",
    });
  });
});

describe("certificateProblem", () => {
  const now = Date.UTC(2026, 10, 17);
  const days = (n: number) => now + n * 86_400_000;

  it("passes a trusted certificate with time left", () => {
    expect(certificateProblem({ validTo: days(60), authorizationError: null }, now)).toBeNull();
    expect(certificateProblem({ validTo: days(14), authorizationError: null }, now)).toBeNull();
  });

  it("fails ahead of expiry, so the renewal is not found out by an outage", () => {
    expect(certificateProblem({ validTo: days(13), authorizationError: null }, now)).toBe(
      "certificate expires in 13 days",
    );
    expect(certificateProblem({ validTo: days(-3), authorizationError: null }, now)).toBe(
      "certificate expired 3 days ago",
    );
  });

  it("fails an untrusted certificate with the reason", () => {
    expect(
      certificateProblem({ validTo: days(300), authorizationError: "SELF_SIGNED_CERT" }, now),
    ).toBe("certificate not trusted: SELF_SIGNED_CERT");
  });
});

describe("notification bodies", () => {
  const payload = {
    event: "incident.opened" as const,
    monitor: { id: "m1", name: "API" },
    at: 1,
    cause: "HTTP 503",
  };

  it("speaks Slack and Discord, and sends the full payload everywhere else", () => {
    expect(bodyFor("https://hooks.slack.com/services/T/B/x", payload)).toEqual({
      text: "🔴 API is down: HTTP 503",
    });
    expect(bodyFor("https://discord.com/api/webhooks/1/x", payload)).toEqual({
      content: "🔴 API is down: HTTP 503",
    });
    expect(bodyFor("https://hooks.example.com/veghe", payload)).toBe(payload);
    expect(
      bodyFor("https://hooks.slack.com/x", {
        ...payload,
        event: "incident.resolved",
        durationMs: 180_000,
      }),
    ).toEqual({ text: "🟢 API recovered after 3 min" });
  });
});
