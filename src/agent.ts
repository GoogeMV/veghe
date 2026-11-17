/**
 * Probe agent entry point. Run one per region:
 *
 *   SERVER_URL=https://status.example.com PROBE_TOKEN=... node dist/agent.js
 */
import { Agent } from "./lib/agent.js";
import { runCheck } from "./lib/checker.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const serverUrl = required("SERVER_URL");
const allowPrivate = process.env.ALLOW_PRIVATE_TARGETS === "true";

const agent = new Agent({
  serverUrl,
  token: required("PROBE_TOKEN"),
  concurrency: Number(process.env.AGENT_CONCURRENCY ?? 10),
  check: (target) => runCheck(target, { allowPrivate }),
  onError: (err) => console.error(`[agent] ${err instanceof Error ? err.message : String(err)}`),
});

agent.start(Number(process.env.AGENT_POLL_MS ?? 1000));
console.log(`[agent] polling ${serverUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    agent.stop();
    process.exit(0);
  });
}
