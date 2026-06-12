import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

export function getRequestToken(request: FastifyRequest, bodyToken?: unknown): string | undefined {
  const header = request.headers["x-admin-token"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }

  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  if (typeof bodyToken === "string" && bodyToken.trim()) {
    return bodyToken.trim();
  }

  const query = request.query as Record<string, unknown> | undefined;
  if (typeof query?.token === "string" && query.token.trim()) {
    return query.token.trim();
  }

  return undefined;
}

export function isAuthorized(config: AppConfig, request: FastifyRequest, bodyToken?: unknown): boolean {
  if (config.allowUnauthenticatedLocal) {
    return true;
  }

  const token = getRequestToken(request, bodyToken);
  return Boolean(config.adminToken && token && token === config.adminToken);
}
