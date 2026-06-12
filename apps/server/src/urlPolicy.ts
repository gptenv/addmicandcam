import net from "node:net";
import type { AppConfig } from "./config.js";

export interface UrlPolicyResult {
  ok: boolean;
  url?: URL;
  reason?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "i");
}

function patternMatches(pattern: string, url: URL): boolean {
  const matcher = globToRegExp(pattern);
  return matcher.test(url.href) || matcher.test(url.hostname);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

export function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "host.docker.internal"
  ) {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

export function validateTargetUrl(rawUrl: string, config: AppConfig): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL must be absolute, for example https://example.com" };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, reason: "Only http:// and https:// URLs are allowed" };
  }

  if (!config.allowPrivateNetworks && isPrivateHostname(url.hostname)) {
    return {
      ok: false,
      reason: "Localhost, private, link-local, and reserved network targets are blocked by default"
    };
  }

  if (config.blockedUrlPatterns.some((pattern) => patternMatches(pattern, url))) {
    return { ok: false, reason: "URL matches BLOCKED_URL_PATTERNS" };
  }

  if (config.allowedUrlPatterns.length > 0 && !config.allowedUrlPatterns.some((pattern) => patternMatches(pattern, url))) {
    return { ok: false, reason: "URL does not match ALLOWED_URL_PATTERNS" };
  }

  return { ok: true, url };
}
