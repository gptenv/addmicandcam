import path from "node:path";
import { existsSync } from "node:fs";

export interface AppConfig {
  host: string;
  port: number;
  baseUrl: string;
  dataDir: string;
  maxSessions: number;
  sessionTtlMs: number;
  uploadMaxBytes: number;
  allowPrivateNetworks: boolean;
  allowedUrlPatterns: string[];
  blockedUrlPatterns: string[];
  headless: boolean;
  viewport: {
    width: number;
    height: number;
  };
  fakeVideo: {
    durationSeconds: number;
    fps: number;
  };
  disclosure: {
    enabled: boolean;
    label: string;
  };
  webDistDir?: string;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function intFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listFromEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveOptionalWebDist(): string | undefined {
  const explicit = process.env.WEB_DIST_DIR;
  const candidates = [
    explicit ? path.resolve(explicit) : undefined,
    path.resolve(process.cwd(), "apps/web/dist"),
    path.resolve(process.cwd(), "../web/dist"),
    path.resolve(process.cwd(), "../../apps/web/dist")
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(path.join(candidate, "index.html"))) ?? candidates[0];
}

export function getConfig(): AppConfig {
  const port = intFromEnv("PORT", 3000);
  const host = process.env.HOST || "0.0.0.0";
  return {
    host,
    port,
    baseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
    dataDir: path.resolve(process.env.APP_DATA_DIR || path.join(process.cwd(), "data")),
    maxSessions: intFromEnv("MAX_SESSIONS", 3),
    sessionTtlMs: intFromEnv("SESSION_TTL_MS", 60 * 60 * 1000),
    uploadMaxBytes: intFromEnv("UPLOAD_MAX_BYTES", 50 * 1024 * 1024),
    allowPrivateNetworks: boolFromEnv("ALLOW_PRIVATE_NETWORKS", false),
    allowedUrlPatterns: listFromEnv("ALLOWED_URL_PATTERNS"),
    blockedUrlPatterns: listFromEnv("BLOCKED_URL_PATTERNS"),
    headless: boolFromEnv("HEADLESS", true),
    viewport: {
      width: intFromEnv("DEFAULT_VIEWPORT_WIDTH", 1280),
      height: intFromEnv("DEFAULT_VIEWPORT_HEIGHT", 720)
    },
    fakeVideo: {
      durationSeconds: intFromEnv("FAKE_VIDEO_DURATION_SECONDS", 12),
      fps: intFromEnv("FAKE_VIDEO_FPS", 30)
    },
    disclosure: {
      enabled: boolFromEnv("DISCLOSURE_WATERMARK_ENABLED", true),
      label: process.env.DISCLOSURE_WATERMARK_LABEL || "AI-assisted"
    },
    webDistDir: resolveOptionalWebDist()
  };
}
