import { isIP, connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { assertPublicTarget, type Target, TargetError } from "./net.js";

export interface CheckTarget {
  url: string;
  timeoutMs: number;
  keyword: string | null;
}

export interface CheckResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export type Checker = (target: CheckTarget) => Promise<CheckResult>;

const MAX_KEYWORD_BODY_BYTES = 256 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A TLS check fails once the certificate has fewer than this many days left. */
export const CERT_WARN_DAYS = 14;

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof TargetError) return err.message;
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `timeout after ${timeoutMs}ms`;
    }
    // Socket errors carry the code directly; undici nests it under `cause`. A
    // host with several addresses (localhost -> ::1 and 127.0.0.1) yields an
    // AggregateError with one error per address.
    type Coded = { code?: unknown; message?: unknown; errors?: { code?: unknown }[] };
    const own = err as Coded;
    const cause = err.cause as Coded | undefined;
    const code = own.code ?? own.errors?.[0]?.code ?? cause?.code ?? cause?.errors?.[0]?.code;
    if (typeof code === "string") return code;
    // "fetch failed" alone says nothing; the cause carries the reason (e.g. "bad port").
    if (typeof cause?.message === "string" && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

/**
 * The verdict on a certificate, as a pure function so the policy is testable
 * without a TLS server. Returns an error message, or null when it is fine.
 */
export function certificateProblem(
  cert: { validTo: number; authorizationError: string | null },
  now: number,
  warnDays = CERT_WARN_DAYS,
): string | null {
  if (cert.authorizationError) return `certificate not trusted: ${cert.authorizationError}`;
  const daysLeft = Math.floor((cert.validTo - now) / DAY_MS);
  if (daysLeft < 0) return `certificate expired ${-daysLeft} days ago`;
  if (daysLeft < warnDays) return `certificate expires in ${daysLeft} days`;
  return null;
}

/**
 * Redirects are not followed. A 3xx counts as "up" (the server answered),
 * and not following means a redirect cannot bounce the request past the
 * SSRF guard to an internal address.
 */
async function checkHttp(target: CheckTarget, started: number): Promise<CheckResult> {
  const res = await fetch(target.url, {
    redirect: "manual",
    signal: AbortSignal.timeout(target.timeoutMs),
    headers: { "user-agent": "veghe/2.0 (uptime monitor)", accept: "*/*" },
  });
  // Latency is time to response headers; the body is not part of it.
  const latencyMs = Math.round(performance.now() - started);
  const statusCode = res.status;

  if (statusCode < 200 || statusCode >= 400) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, statusCode, latencyMs, error: `HTTP ${statusCode}` };
  }
  if (target.keyword) {
    const body = await readCapped(res, MAX_KEYWORD_BODY_BYTES);
    if (!body.includes(target.keyword)) {
      return { ok: false, statusCode, latencyMs, error: "keyword not found in response" };
    }
  } else {
    await res.body?.cancel().catch(() => {});
  }
  return { ok: true, statusCode, latencyMs, error: null };
}

/** Up when the port accepts a connection. Latency is time to connect. */
function checkTcp(target: Target, timeoutMs: number, started: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host: target.host, port: target.port });
    const finish = (error: string | null) => {
      socket.destroy();
      resolve({
        ok: error === null,
        statusCode: null,
        latencyMs: error === null ? Math.round(performance.now() - started) : null,
        error,
      });
    };
    socket.setTimeout(timeoutMs, () => finish(`timeout after ${timeoutMs}ms`));
    socket.once("connect", () => finish(null));
    socket.once("error", (err) => finish(describeError(err, timeoutMs)));
  });
}

/**
 * Up when the handshake completes with a trusted certificate that is not
 * about to expire. Catches the outage nobody notices coming: the forgotten
 * renewal. Latency is time to a completed handshake.
 */
function checkTls(target: Target, timeoutMs: number, started: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    // rejectUnauthorized is off so that an untrusted certificate is reported
    // with its reason instead of as a bare connection error; trust is still
    // enforced below through `authorized`. No data is ever sent on the socket.
    const socket = tlsConnect({
      host: target.host,
      port: target.port,
      // SNI is for names; RFC 6066 forbids sending an IP address.
      ...(isIP(target.host) === 0 && { servername: target.host }),
      rejectUnauthorized: false,
    });
    const finish = (error: string | null, connected: boolean) => {
      socket.destroy();
      resolve({
        ok: error === null,
        statusCode: null,
        latencyMs: connected ? Math.round(performance.now() - started) : null,
        error,
      });
    };
    socket.setTimeout(timeoutMs, () => finish(`timeout after ${timeoutMs}ms`, false));
    socket.once("error", (err) => finish(describeError(err, timeoutMs), false));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const problem = certificateProblem(
        {
          validTo: Date.parse(cert.valid_to),
          authorizationError: socket.authorized ? null : String(socket.authorizationError),
        },
        Date.now(),
      );
      finish(problem, true);
    });
  });
}

/** One check of any kind. Never throws: every failure mode becomes a CheckResult. */
export async function runCheck(
  target: CheckTarget,
  opts: { allowPrivate: boolean },
): Promise<CheckResult> {
  const started = performance.now();
  try {
    const parsed = await assertPublicTarget(target.url, opts.allowPrivate);
    switch (parsed.kind) {
      case "http":
        return await checkHttp(target, started);
      case "tcp":
        return await checkTcp(parsed, target.timeoutMs, started);
      case "tls":
        return await checkTls(parsed, target.timeoutMs, started);
    }
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      error: describeError(err, target.timeoutMs),
    };
  }
}
