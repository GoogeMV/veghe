/**
 * Local demo: runs one agent per entry in PROBE_TOKENS, all in this process,
 * against the dev server. The "regions" are just names here; every agent
 * checks from this machine.
 *
 *   npm run demo:agents
 *   npm run demo:agents -- --partition us-east=example.com
 *
 * --partition REGION=HOST makes that region's checks of that host fail, to
 * show what a regional network problem looks like: the monitor turns
 * "degraded", and no incident opens because the other regions disagree.
 * It is a simulation, and the failure message says so.
 */
import { Agent } from "../src/lib/agent.js";
import { runCheck } from "../src/lib/checker.js";

const serverUrl = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? "8083"}`;
const allowPrivate = process.env.ALLOW_PRIVATE_TARGETS === "true";

const partitions = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--partition" && args[i + 1]) {
    const [region, host] = (args[++i] as string).split("=");
    if (region && host) partitions.set(region, host);
  }
}

const entries = (process.env.PROBE_TOKENS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const split = entry.indexOf(":");
    return { region: entry.slice(0, split), token: entry.slice(split + 1) };
  });

if (entries.length === 0) {
  console.error("PROBE_TOKENS is empty; set it in .env (see .env.example).");
  process.exit(1);
}

for (const { region, token } of entries) {
  const blockedHost = partitions.get(region);
  const agent = new Agent({
    serverUrl,
    token,
    concurrency: 10,
    check: async (target) => {
      if (blockedHost && new URL(target.url).hostname === blockedHost) {
        return {
          ok: false,
          statusCode: null,
          latencyMs: null,
          error: "simulated network partition (demo)",
        };
      }
      return runCheck(target, { allowPrivate });
    },
    onError: (err) => console.error(`[${region}] ${err instanceof Error ? err.message : err}`),
  });
  agent.start(1000);
  console.log(
    `[${region}] polling ${serverUrl}${blockedHost ? ` (partitioned from ${blockedHost})` : ""}`,
  );
}
