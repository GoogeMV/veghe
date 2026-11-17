import type { Status } from "./state.js";

const COLORS: Record<Status | "paused", string> = {
  up: "#2ea44f",
  degraded: "#bf8700",
  down: "#cf222e",
  pending: "#6e7781",
  paused: "#6e7781",
};

const escapeXml = (text: string) => text.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Close enough to 11px Verdana for laying out two short strings. */
const textWidth = (text: string) => Math.round(text.length * 6.6 + 12);

export function badgeMessage(status: Status | "paused", uptime: number | null): string {
  if (status === "paused" || status === "pending" || uptime === null) return status;
  // Never round a non-perfect record up to 100%.
  const pct = uptime === 1 ? "100" : Math.min(uptime * 100, 99.99).toFixed(2);
  return `${status} · ${pct}%`;
}

/**
 * A two-part status badge as a self-contained SVG, for READMEs and
 * dashboards. The text is in the SVG's title and aria-label, so the status
 * is not carried by colour alone.
 */
export function renderBadge(label: string, status: Status | "paused", message: string): string {
  const left = label.length > 40 ? `${label.slice(0, 39)}…` : label;
  const leftWidth = textWidth(left);
  const rightWidth = textWidth(message);
  const width = leftWidth + rightWidth;
  const title = escapeXml(`${left}: ${message}`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">
<title>${title}</title>
<clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath>
<g clip-path="url(#r)">
<rect width="${leftWidth}" height="20" fill="#3a3f47"/>
<rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${COLORS[status]}"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${leftWidth / 2}" y="14">${escapeXml(left)}</text>
<text x="${leftWidth + rightWidth / 2}" y="14">${escapeXml(message)}</text>
</g>
</svg>`;
}
