# veghe

A distributed uptime monitor with a live public status page. Probe agents in several regions check HTTP endpoints, TCP ports and TLS certificates; a monitor is declared down only when a majority of regions agree. It keeps 90 days of history and pushes every result to the page over Server-Sent Events.

*veghe* is Romanian for a watch or vigil.

```
   agent (eu-west) ──┐   POST /api/probe/claim     ┌──────────────────────────┐
   agent (us-east) ──┼── POST /api/probe/results ─►│  server                  │
   agent (ap-south) ─┘   outbound HTTPS only       │                          │
                                                   │  claim = lease           │
   built-in probe (in-process, same code path) ───►│  record = one transaction│
                                                   │    region vote           │
            targets ◄── HTTP / TCP / TLS checks    │    quorum ─► status      │
            from every probe                       │    incident open/close   │
                                                   │    daily rollup          │
                                                   └───────┬──────────┬───────┘
                                                        SQLite     EventBus
                                                           │          ├─► SSE ─► status page
                                                  GET /api/status     └─► webhook / Slack / Discord
```

## Run it

```bash
npm install
cp .env.example .env        # then set ADMIN_TOKEN and the probe tokens
npm run seed                # optional demo data, see below
npm run dev
```

In a second terminal, start one agent per entry in `PROBE_TOKENS`:

```bash
npm run demo:agents
```

Open the page, click **Manage**, paste the admin token and add a monitor. A target's scheme picks the check:

| Target | Up when |
| --- | --- |
| `https://host/path` | The response is 2xx or 3xx, and contains the keyword if one is set |
| `tcp://host:port` | The port accepts a connection |
| `tls://host[:443]` | The handshake succeeds with a trusted certificate that has at least 14 days left |

`npm run seed` creates five demo monitors and fills in 89 days of **synthetic** history, so the page has something to show before real checks have accumulated. Nothing before "today" in a seeded database was measured.

`npm run demo:agents -- --partition us-east=example.com` makes one region's checks of one host fail, to show a regional network problem: the monitor turns *degraded* and no incident opens. On one machine the "regions" are only names; every agent checks from the same place.

A real agent is one process with two settings:

```bash
SERVER_URL=https://status.example.com PROBE_TOKEN=... node dist/agent.js
```

## API

Public, read-only:

| Method | Path | |
| --- | --- | --- |
| GET | `/api/status` | Everything the page renders: overall state, per-monitor uptime, per-region votes, 90 daily buckets, recent latency, incidents |
| GET | `/api/status/:id` | One monitor in depth: per-region uptime, mean and p95 latency, recent checks, its incidents |
| GET | `/badge/:id.svg` | Embeddable status badge |
| GET | `/api/stream` | SSE: `check`, `incident` and `monitors` events |
| GET | `/healthz`, `/metrics` | Liveness and Prometheus metrics |

Admin, `Authorization: Bearer $ADMIN_TOKEN`:

| Method | Path | |
| --- | --- | --- |
| GET, POST | `/api/monitors` | `name`, `url`, optional `intervalSeconds` (60), `timeoutMs` (5000), `failureThreshold` (2), `keyword`, `webhookUrl` |
| PATCH, DELETE | `/api/monitors/:id` | Pause or resume; delete with history |
| GET, POST | `/api/probes` | Register a region; the probe token is returned once and stored as a hash |
| DELETE | `/api/probes/:id` | Remove a probe and withdraw its votes |

Agents, `Authorization: Bearer $PROBE_TOKEN`:

| Method | Path | |
| --- | --- | --- |
| POST | `/api/probe/claim` | `{ limit }` → the checks due for this probe's region |
| POST | `/api/probe/results` | `{ results: [...] }` → recorded, counted towards quorum |

## Design decisions

**Agents pull; the server never calls them.** An agent asks "what is due for my region?", runs those checks and posts the results. It holds no schedule and no state, needs no inbound port, and works behind NAT. Adding a region is starting a process.

**Claiming is the lease.** `claim` selects a region's due checks and books each one's next run in the same transaction ([`db.ts`](src/db.ts)). Two agents sharing a region can therefore never be handed the same check, and there is nothing to clean up when an agent dies mid-check: the lease is not a lock that must be released, the check is simply due again one interval later. A lost result is not retried, because a late vote is a stale vote.

**Two pure functions decide everything** ([`state.ts`](src/lib/state.ts)). `transition` is per-region flap damping: a region votes "down" only after `failureThreshold` consecutive failures and "up" after one success. `aggregate` is quorum: *down* when a strict majority of voting regions say so, *degraded* when a minority does. One probe with a broken network path cannot open an incident. Both are tested as tables of inputs and outputs, with no clock, network or database.

**Silent regions stop voting, and a sweeper notices.** A region's vote counts only while it is fresh (three check intervals). A probe that crashes while reporting "down" would otherwise hold that vote forever; instead it goes stale and drops out of the quorum. Results only arrive from live probes, so a timer re-evaluates every monitor twice a minute: a status change caused by silence is announced exactly like one caused by a check.

**One voice is never an outage.** While two or more regions are known for a monitor, at least two fresh votes are needed for "down". Without that, the first probe to report after a restart (when every other vote is stale) would be the whole electorate; I found this in the demo as an incident that opened and resolved in the same second. With a single fresh failing region the monitor is "degraded": suspicion, not an alert. Recovery is not guarded. The cost is deliberate: if all probes but one are dead and the target really fails, no incident opens until a second probe confirms.

**One transaction per result.** The raw check, the daily rollup, the region's vote, the monitor's status and the incident open/close are written together or not at all. A crash can never leave an "up" monitor with an open incident.

**The built-in probe is the same code path.** With no agents at all, veghe still works as a single binary: an in-process probe runs the same claim/record cycle against the repository that remote agents run over HTTP. It is one more region, not a special case.

**A probe token is one region's identity, nothing more.** Tokens are random, shown once and stored hashed. A leaked token lets someone lie for that one region, which is exactly the failure quorum outvotes. Results are stamped with the server's clock, so agents' clocks do not need to agree.

**Rollups make long-range uptime cheap.** `daily_stats` holds one row per monitor per UTC day, updated in the result transaction, so the 90-day bar reads 90 rows and raw checks can be trimmed (7 days by default) without changing any figure. There is a test for exactly that.

**Uptime is counted in checks, not in time,** across all regions. That is honest about what was measured, but it means a regional blip lowers the figure a little even though no incident opened.

**The public page never sees monitor URLs.** Health-check URLs often carry tokens, so `/api/status` exposes only the host.

**SSRF guard on everything veghe connects to,** in the server and in every agent. Targets of all three kinds and webhook URLs are resolved and refused on loopback, private or link-local ranges unless `ALLOW_PRIVATE_TARGETS=true`. Redirects are not followed.

**Chat webhooks by pasting a URL.** A Slack or Discord webhook URL is recognised by its host and sent the shape that service expects; anything else receives the full JSON payload.

**Webhooks are signed and retried.** With `WEBHOOK_SECRET` set, each delivery carries `x-veghe-signature: sha256=…`, an HMAC over `<timestamp>.<body>`; the timestamp is inside the signed string so a captured delivery cannot be replayed with a fresh one. Network errors, 5xx and 429 are retried twice (after 1s and 5s) with the same `x-veghe-delivery` id, so a receiver can de-duplicate; a 4xx is a refusal and is not retried.

**Status badges.** `/badge/<monitor id>.svg` is a self-contained SVG with the monitor's status and 90-day uptime, cacheable for a minute, for READMEs and wikis. The detail panel on the page gives the Markdown to paste.

## Known limits

- **One server.** Agents scale out, the server does not: SQLite and the in-process `EventBus` assume a single instance. The claim transaction is already the right shape for Postgres (`UPDATE … RETURNING` with `SKIP LOCKED`); the bus would become `LISTEN/NOTIFY` or Redis.
- **Every probe checks every monitor.** There is no per-monitor region selection, and quorum is a fixed strict majority.
- **DNS rebinding.** The SSRF guard resolves the host, then the connection resolves it again. Closing that means pinning the resolved address in a connect hook.
- **TLS warning window is fixed** at 14 days.
- **Webhook retries live in memory.** A restart between attempts loses that notification; the incident itself is always in the database.
- **One shared admin token,** no users or roles.

## Configuration

Server:

| Variable | Default | |
| --- | --- | --- |
| `ADMIN_TOKEN` | *(required, ≥ 16 chars)* | The server refuses to start without it |
| `PORT` | `8083` | |
| `DB_PATH` | `data/veghe.db` | |
| `PROBE_TOKENS` | | `region:token,region:token`; probes declared up front |
| `LOCAL_PROBE` / `LOCAL_REGION` | `true` / `local` | The built-in probe and the region it votes as |
| `WEBHOOK_SECRET` | | Signs outgoing webhooks when set (≥ 16 chars) |
| `SWEEP_MS` | `30000` | How often silent regions are re-evaluated |
| `ALLOW_PRIVATE_TARGETS` | `false` | Set `true` to monitor localhost in development |
| `SCHEDULER_TICK_MS` / `CHECK_CONCURRENCY` | `1000` / `10` | Built-in probe |
| `RAW_RETENTION_DAYS` | `7` | Raw checks only; daily rollups are kept |
| `RATE_LIMIT_GLOBAL_MAX` / `RATE_LIMIT_WINDOW_MS` | `600` / `60000` | Probe endpoints are exempt |

Agent: `SERVER_URL`, `PROBE_TOKEN` (both required), `AGENT_POLL_MS` (1000), `AGENT_CONCURRENCY` (10), `ALLOW_PRIVATE_TARGETS`.

## Development

```bash
npm test          # incl. real agents over HTTP, real TCP/HTTP targets and a live SSE stream
npm run typecheck
npm run lint
```

`docker-compose.yml` runs the server with two agents:

```bash
ADMIN_TOKEN=... EU_WEST_TOKEN=... US_EAST_TOKEN=... docker compose up --build
```

Stack: Fastify 5, TypeBox, better-sqlite3, prom-client, Vitest, Biome, TypeScript in strict mode. The frontend is plain HTML, CSS and JavaScript with no build step.
