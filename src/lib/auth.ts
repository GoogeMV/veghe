import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Adds a hook to the given plugin scope that rejects requests without the admin token. */
export function requireAdmin(app: FastifyInstance): void {
  const expected = sha256(app.config.adminToken);
  app.addHook("onRequest", async (request, reply) => {
    // Hashing first gives equal-length inputs, so the comparison leaks no length.
    if (!timingSafeEqual(sha256(bearerToken(request.headers.authorization)), expected)) {
      return reply.code(401).send({ error: "unauthorized", message: "admin token required" });
    }
  });
}
