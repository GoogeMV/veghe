const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

/** Tiny DOM builder. Text always goes through textContent, never innerHTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const DAY_MS = 86_400_000;

function pct(ratio) {
  if (ratio === null) return "–";
  const value = ratio * 100;
  // Never round a non-perfect record up to "100%".
  if (value === 100) return "100%";
  return `${Math.min(value, 99.99).toFixed(2)}%`;
}

function ago(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function barLevel(day) {
  if (day.total === 0) return "none";
  const ratio = day.up / day.total;
  if (ratio >= 0.995) return "up";
  return ratio >= 0.95 ? "warn" : "down";
}

/** One line per region on a shared time axis; series colours match the region chips. */
function sparkline(points, regions) {
  const width = 200;
  const height = 44;
  const pad = 3;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Response time by region, recent checks");

  const timed = points.filter((p) => p.ms !== null);
  if (points.length < 2 || timed.length === 0) return svg;

  const first = points[0].at;
  const span = Math.max(points[points.length - 1].at - first, 1);
  const max = Math.max(...timed.map((p) => p.ms), 1);
  const x = (at) => pad + ((at - first) / span) * (width - pad * 2);
  const y = (ms) => height - pad - (ms / max) * (height - pad * 2);

  regions.forEach((region, index) => {
    // Failed checks have no latency: break the line there and mark the gap.
    let path = "";
    let pen = false;
    for (const point of points) {
      if (point.region !== region) continue;
      if (point.ms === null) {
        pen = false;
        const mark = document.createElementNS(SVG_NS, "circle");
        mark.setAttribute("class", "spark-fail");
        mark.setAttribute("cx", x(point.at).toFixed(1));
        mark.setAttribute("cy", String(height - pad));
        mark.setAttribute("r", "1.8");
        svg.append(mark);
        continue;
      }
      path += `${pen ? "L" : "M"}${x(point.at).toFixed(1)} ${y(point.ms).toFixed(1)}`;
      pen = true;
    }
    if (!path) return;
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("class", `spark-line series-${index % SERIES}`);
    line.setAttribute("d", path);
    svg.prepend(line);
  });
  return svg;
}

const SERIES = 4;

function regionReading(region) {
  if (region.stale) return "stale";
  if (region.status === "down") return "down";
  return region.lastLatencyMs === null ? "…" : `${region.lastLatencyMs} ms`;
}

function regionChips(monitor) {
  return h(
    "div",
    { class: "regions" },
    monitor.regions.map((region, index) =>
      h(
        "span",
        {
          class: `region series-${index % SERIES}`,
          "data-status": region.stale ? "stale" : region.status,
          title: region.stale
            ? "No recent check from this region; it is not counted"
            : (region.lastError ??
              `Last check ${region.lastCheckedAt ? ago(region.lastCheckedAt) : "never"}`),
        },
        h("span", { class: "region-dot", "aria-hidden": "true" }),
        region.region,
        h("span", { class: "region-ms" }, regionReading(region)),
      ),
    ),
  );
}

function statusLabel(monitor) {
  if (monitor.paused) return "Paused";
  return { up: "Operational", degraded: "Degraded", down: "Down", pending: "Pending" }[
    monitor.status
  ];
}

// ---- per-monitor detail panel ----

/** Ids of cards whose detail panel is open; survives the re-render every refresh does. */
const expanded = new Set();
/** id -> last detail payload from /api/status/:id */
const details = new Map();
let lastStatus = null;

async function loadDetails(id) {
  try {
    const res = await fetch(`/api/status/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    details.set(id, await res.json());
  } catch {
    return;
  }
  if (lastStatus && expanded.has(id)) render(lastStatus);
}

function toggleDetails(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  if (lastStatus) render(lastStatus);
  if (expanded.has(id)) loadDetails(id);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

function detailPanel(monitor) {
  const data = details.get(monitor.id);
  if (!data) return h("div", { class: "detail" }, h("p", { class: "muted" }, "Loading…"));

  const badgeUrl = `${location.origin}/badge/${monitor.id}.svg`;
  const failures = data.checks.filter((check) => !check.ok).slice(0, 5);
  // Oldest on the left, like the 90-day strip above it.
  const strip = [...data.checks].reverse();

  return h(
    "div",
    { class: "detail" },
    h(
      "section",
      {},
      h("h4", {}, "By region, last 24 hours"),
      data.regions.length === 0
        ? h("p", { class: "muted" }, "No checks in the last 24 hours.")
        : h(
            "table",
            { class: "detail-table" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "Region"),
                h("th", { class: "num" }, "Checks"),
                h("th", { class: "num" }, "Uptime"),
                h("th", { class: "num" }, "Mean"),
                h("th", { class: "num" }, "p95"),
              ),
            ),
            h(
              "tbody",
              {},
              data.regions.map((region) =>
                h(
                  "tr",
                  {},
                  h("td", {}, region.region),
                  h("td", { class: "num" }, region.checks),
                  h("td", { class: "num" }, pct(region.uptime)),
                  h("td", { class: "num" }, region.meanMs === null ? "–" : `${region.meanMs} ms`),
                  h("td", { class: "num" }, region.p95Ms === null ? "–" : `${region.p95Ms} ms`),
                ),
              ),
            ),
          ),
    ),
    h(
      "section",
      {},
      h("h4", {}, `Last ${strip.length} checks`),
      h(
        "div",
        {
          class: "check-strip",
          role: "img",
          "aria-label": `${failures.length} of the last ${strip.length} checks failed`,
        },
        strip.map((check) =>
          h("span", {
            class: "check",
            "data-ok": String(check.ok),
            title: `${timeFmt.format(check.at)} · ${check.region} · ${check.ok ? `${check.latencyMs} ms` : (check.error ?? "failed")}`,
          }),
        ),
      ),
      failures.length > 0 &&
        h(
          "ul",
          { class: "failure-list" },
          failures.map((check) =>
            h(
              "li",
              {},
              h("span", { class: "muted" }, `${timeFmt.format(check.at)} · ${check.region}`),
              " ",
              h("code", {}, check.error ?? "failed"),
            ),
          ),
        ),
    ),
    h(
      "section",
      {},
      h("h4", {}, "Incidents"),
      data.incidents.length === 0
        ? h("p", { class: "muted" }, "None recorded for this monitor.")
        : h(
            "ul",
            { class: "failure-list" },
            data.incidents
              .slice(0, 5)
              .map((incident) =>
                h(
                  "li",
                  {},
                  h("span", { class: "muted" }, dateTimeFmt.format(incident.startedAt)),
                  " ",
                  incident.resolvedAt === null
                    ? "ongoing"
                    : `lasted ${duration(incident.resolvedAt - incident.startedAt)}`,
                  " · ",
                  h("code", {}, incident.cause ?? "unknown cause"),
                ),
              ),
          ),
    ),
    h(
      "section",
      {},
      h("h4", {}, "Status badge"),
      h(
        "div",
        { class: "badge-row" },
        h("img", {
          src: `/badge/${monitor.id}.svg`,
          alt: `Status badge for ${monitor.name}`,
          height: "20",
        }),
        h("input", {
          class: "badge-code",
          readonly: "",
          "aria-label": "Markdown for this badge",
          value: `![${monitor.name}](${badgeUrl})`,
          onfocus: (event) => event.target.select(),
        }),
      ),
    ),
  );
}

function monitorCard(monitor) {
  const stat = (label, value) =>
    h(
      "div",
      {},
      h("span", { class: "stat-label" }, label),
      h("span", { class: "stat-value" }, value),
    );

  return h(
    "article",
    { class: "card", "data-id": monitor.id },
    h(
      "div",
      { class: "card-head" },
      h(
        "div",
        {},
        h("h3", { class: "card-name" }, monitor.name),
        h("span", { class: "card-host" }, `${monitor.kind} · ${monitor.host}`),
      ),
      h(
        "span",
        { class: "pill", "data-status": monitor.paused ? "paused" : monitor.status },
        statusLabel(monitor),
      ),
    ),
    monitor.lastError && !monitor.paused && h("p", { class: "card-error" }, monitor.lastError),
    h(
      "div",
      { class: "card-body" },
      h(
        "div",
        { class: "stats" },
        stat("24 hours", pct(monitor.uptime.h24)),
        stat("7 days", pct(monitor.uptime.d7)),
        stat("90 days", pct(monitor.uptime.d90)),
        stat("Response", monitor.lastLatencyMs === null ? "–" : `${monitor.lastLatencyMs} ms`),
        stat("Checked", monitor.lastCheckedAt === null ? "never" : ago(monitor.lastCheckedAt)),
      ),
      sparkline(
        monitor.latency,
        monitor.regions.map((r) => r.region),
      ),
    ),
    monitor.regions.length > 0 && regionChips(monitor),
    h(
      "div",
      {
        class: "bars",
        role: "img",
        "aria-label": `Daily uptime, last ${monitor.days.length} days`,
      },
      monitor.days.map((day) =>
        h("span", {
          class: "bar",
          "data-level": barLevel(day),
          title:
            day.total === 0
              ? `${dateFmt.format(day.day * DAY_MS)}: no data`
              : `${dateFmt.format(day.day * DAY_MS)}: ${pct(day.up / day.total)} (${day.up}/${day.total} checks)`,
        }),
      ),
    ),
    h(
      "div",
      { class: "bars-legend" },
      h("span", {}, `${monitor.days.length} days ago`),
      h("span", {}, "today"),
    ),
    h(
      "button",
      {
        class: "btn small details-toggle",
        type: "button",
        "aria-expanded": String(expanded.has(monitor.id)),
        onclick: () => toggleDetails(monitor.id),
      },
      expanded.has(monitor.id) ? "Hide details" : "Details",
    ),
    expanded.has(monitor.id) && detailPanel(monitor),
  );
}

const BANNERS = {
  operational: "All systems operational",
  degraded: "Some systems are degraded",
  outage: "Major outage",
  unknown: "Waiting for first checks",
};

function render(status) {
  lastStatus = status;
  $("banner").dataset.overall = status.overall;
  $("banner-title").textContent =
    status.monitors.length === 0 ? "No monitors yet" : BANNERS[status.overall];
  const down = status.monitors.filter((m) => m.status === "down" && !m.paused).length;
  const degraded = status.monitors.filter((m) => m.status === "degraded" && !m.paused).length;
  const regions = new Set(status.monitors.flatMap((m) => m.regions.map((r) => r.region))).size;
  $("banner-sub").textContent =
    status.monitors.length === 0
      ? "Open Manage to add the first one."
      : `${status.monitors.length} monitored from ${regions} ${regions === 1 ? "region" : "regions"} · ${down} down · ${degraded} degraded · updated ${new Date(status.generatedAt).toLocaleTimeString()}`;

  $("monitors").replaceChildren(
    ...(status.monitors.length === 0
      ? [h("div", { class: "empty" }, "Nothing is being monitored yet.")]
      : status.monitors.map(monitorCard)),
  );

  $("incidents").replaceChildren(
    ...(status.incidents.length === 0
      ? [h("li", { class: "empty" }, "No incidents recorded.")]
      : status.incidents.map((incident) => {
          const open = incident.resolvedAt === null;
          return h(
            "li",
            { class: "incident" },
            h(
              "span",
              { class: "incident-tag", "data-open": String(open) },
              open ? "Ongoing" : "Resolved",
            ),
            h(
              "div",
              {},
              h("strong", {}, incident.monitorName),
              h("span", { class: "incident-cause" }, incident.cause ?? "unknown cause"),
            ),
            h(
              "span",
              { class: "incident-when" },
              dateTimeFmt.format(incident.startedAt),
              " · ",
              open
                ? `for ${duration(Date.now() - incident.startedAt)}`
                : `lasted ${duration(incident.resolvedAt - incident.startedAt)}`,
            ),
          );
        })),
  );
}

let pendingFlash = new Set();
let refreshTimer = null;

async function refresh() {
  let status;
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    status = await res.json();
  } catch {
    return; // server unreachable: keep the last render, EventSource will reconnect
  }
  render(status);
  for (const id of expanded) loadDetails(id);
  for (const id of pendingFlash) {
    const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!card) continue;
    card.classList.add("flash");
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("flash")));
  }
  pendingFlash = new Set();
}

/** Events only say "something changed"; a burst of them costs one refetch. */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refresh();
    if ($("manage").open) {
      loadAdminList();
      loadProbes();
    }
  }, 250);
}

function setLive(state, text) {
  $("live").dataset.state = state;
  $("live-text").textContent = text;
}

function connect() {
  const source = new EventSource("/api/stream");
  source.onopen = () => {
    setLive("live", "live");
    refresh(); // catch up on anything missed while disconnected
  };
  source.onerror = () => setLive("offline", "reconnecting");
  source.addEventListener("check", (event) => {
    pendingFlash.add(JSON.parse(event.data).monitorId);
    scheduleRefresh();
  });
  source.addEventListener("incident", scheduleRefresh);
  source.addEventListener("monitors", scheduleRefresh);
}

// ---- admin dialog ----

const TOKEN_KEY = "veghe.adminToken";

function adminError(message) {
  $("admin-error").textContent = message ?? "";
  $("admin-error").hidden = !message;
}

async function admin(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${$("token").value}`,
      ...(body && { "content-type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.message ?? `request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

async function loadAdminList() {
  if (!$("token").value) {
    $("admin-list").replaceChildren();
    return;
  }
  try {
    const { monitors } = await admin("GET", "/api/monitors");
    adminError(null);
    $("admin-list").replaceChildren(
      ...monitors.map((monitor) =>
        h(
          "li",
          {},
          h("span", { class: "admin-name", title: monitor.url }, monitor.name),
          h(
            "button",
            {
              class: "btn small",
              type: "button",
              onclick: () =>
                admin("PATCH", `/api/monitors/${monitor.id}`, { paused: !monitor.paused }).catch(
                  (err) => adminError(err.message),
                ),
            },
            monitor.paused ? "Resume" : "Pause",
          ),
          h(
            "button",
            {
              class: "btn small danger",
              type: "button",
              onclick: () => {
                if (!confirm(`Delete "${monitor.name}" and its history?`)) return;
                admin("DELETE", `/api/monitors/${monitor.id}`).catch((err) =>
                  adminError(err.message),
                );
              },
            },
            "Delete",
          ),
        ),
      ),
    );
  } catch (err) {
    $("admin-list").replaceChildren();
    adminError(err.message);
  }
}

async function loadProbes() {
  if (!$("token").value) {
    $("probe-list").replaceChildren();
    return;
  }
  try {
    const { local, probes } = await admin("GET", "/api/probes");
    $("probe-list").replaceChildren(
      ...(local
        ? [
            h(
              "li",
              {},
              h("span", { class: "admin-name" }, local),
              h("span", { class: "muted" }, "built in"),
            ),
          ]
        : []),
      ...probes.map((probe) =>
        h(
          "li",
          {},
          h("span", { class: "admin-name" }, probe.region),
          h(
            "span",
            { class: "muted" },
            probe.lastSeenAt ? `seen ${ago(probe.lastSeenAt)}` : "never connected",
          ),
          h(
            "button",
            {
              class: "btn small danger",
              type: "button",
              onclick: () => {
                if (!confirm(`Remove probe "${probe.region}"? Its votes are withdrawn.`)) return;
                admin("DELETE", `/api/probes/${probe.id}`).then(loadProbes, (err) =>
                  adminError(err.message),
                );
              },
            },
            "Remove",
          ),
        ),
      ),
    );
  } catch {
    $("probe-list").replaceChildren();
  }
}

$("probe-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const probe = await admin("POST", "/api/probes", { region: new FormData(form).get("region") });
    adminError(null);
    form.reset();
    // The token is shown once; the server keeps only its hash.
    $("probe-token").hidden = false;
    $("probe-token").textContent = `PROBE_TOKEN for ${probe.region} (shown once): ${probe.token}`;
    loadProbes();
  } catch (err) {
    adminError(err.message);
  }
});

$("manage-open").addEventListener("click", () => {
  // sessionStorage: the token is gone when the tab closes.
  $("token").value = sessionStorage.getItem(TOKEN_KEY) ?? "";
  adminError(null);
  $("probe-token").hidden = true;
  $("manage").showModal();
  loadAdminList();
  loadProbes();
});
$("manage-close").addEventListener("click", () => $("manage").close());
$("token").addEventListener("change", () => {
  sessionStorage.setItem(TOKEN_KEY, $("token").value);
  loadAdminList();
  loadProbes();
});

$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const body = {
    name: data.get("name"),
    url: data.get("url"),
    intervalSeconds: Number(data.get("intervalSeconds")),
    failureThreshold: Number(data.get("failureThreshold")),
    ...(data.get("keyword") && { keyword: data.get("keyword") }),
    ...(data.get("webhookUrl") && { webhookUrl: data.get("webhookUrl") }),
  };
  try {
    await admin("POST", "/api/monitors", body);
    adminError(null);
    form.reset();
  } catch (err) {
    adminError(err.message);
  }
});

refresh();
connect();
// "Checked 12s ago" and ongoing-incident durations keep ticking between events.
setInterval(refresh, 30_000);
