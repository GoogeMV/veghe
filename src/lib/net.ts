import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Thrown when a target is not something veghe is willing to connect to. */
export class TargetError extends Error {}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata endpoints
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 127], // unspecified + loopback
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  // An IPv4-mapped IPv6 address is judged by the IPv4 address inside it.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped?.[1] ?? address;
  const family = isIP(ip);
  if (family === 0) return true; // not an IP at all: refuse
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export type TargetKind = "http" | "tcp" | "tls";

export interface Target {
  kind: TargetKind;
  host: string;
  port: number;
  /** The original string; for http this is what gets fetched. */
  url: string;
}

function parse(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new TargetError("not a valid URL");
  }
}

function hostOf(url: URL): string {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new TargetError("target has no host");
  return host;
}

/**
 * A monitor target is a URL whose scheme picks the check:
 *   https://host/path   HTTP GET, up on any 2xx/3xx
 *   tcp://host:port     the port accepts a connection
 *   tls://host[:443]    TLS handshake succeeds and the certificate is not about to expire
 */
export function parseTarget(raw: string): Target {
  const url = parse(raw);
  if (url.username || url.password) {
    throw new TargetError("URLs with embedded credentials are not supported");
  }
  switch (url.protocol) {
    case "http:":
    case "https:":
      return {
        kind: "http",
        host: hostOf(url),
        port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
        url: raw,
      };
    case "tcp:":
      if (!url.port)
        throw new TargetError("tcp targets need a port, e.g. tcp://db.example.com:5432");
      return { kind: "tcp", host: hostOf(url), port: Number(url.port), url: raw };
    case "tls:":
      return { kind: "tls", host: hostOf(url), port: Number(url.port) || 443, url: raw };
    default:
      throw new TargetError("supported schemes are http, https, tcp and tls");
  }
}

/** Webhook destinations: http(s) only. */
export function parseHttpUrl(raw: string): URL {
  const target = parseTarget(raw);
  if (target.kind !== "http") throw new TargetError("only http and https URLs are supported");
  return new URL(raw);
}

/**
 * SSRF guard: resolves the host and refuses private, loopback and link-local
 * addresses. Known limit: the connection that follows resolves DNS again, so
 * a host that changes its answer between the two lookups (DNS rebinding) gets
 * through. Closing that needs a connect hook that pins the resolved address.
 */
export async function assertPublicTarget(raw: string, allowPrivate: boolean): Promise<Target> {
  const target = parseTarget(raw);
  if (allowPrivate) return target;

  const addresses = isIP(target.host)
    ? [target.host]
    : (await lookup(target.host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new TargetError("target resolves to a private or loopback address");
  }
  return target;
}
