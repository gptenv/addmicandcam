import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { globToRegExp, isPrivateHostname, validateTargetUrl } from "./urlPolicy.js";

const baseConfig: AppConfig = {
  host: "127.0.0.1",
  port: 3000,
  baseUrl: "http://localhost:3000",
  dataDir: "/tmp/lab",
  allowUnauthenticatedLocal: true,
  maxSessions: 3,
  sessionTtlMs: 1000,
  uploadMaxBytes: 1024,
  allowPrivateNetworks: false,
  allowedUrlPatterns: [],
  blockedUrlPatterns: [],
  headless: true,
  viewport: { width: 1280, height: 720 },
  fakeVideo: { durationSeconds: 12, fps: 30 },
  disclosure: { enabled: true, label: "AI-assisted" }
};

describe("urlPolicy", () => {
  it("blocks private network targets by default", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("127.0.0.1")).toBe(true);
    expect(isPrivateHostname("192.168.1.10")).toBe(true);
    expect(validateTargetUrl("http://localhost:9999", baseConfig).ok).toBe(false);
  });

  it("allows public http and https URLs", () => {
    expect(validateTargetUrl("https://example.com", baseConfig).ok).toBe(true);
    expect(validateTargetUrl("http://example.com/path", baseConfig).ok).toBe(true);
  });

  it("supports allow and block glob patterns", () => {
    expect(globToRegExp("https://*.example.com/*").test("https://www.example.com/a")).toBe(true);
    const config = { ...baseConfig, allowedUrlPatterns: ["https://*.example.com/*"] };
    expect(validateTargetUrl("https://docs.example.com/start", config).ok).toBe(true);
    expect(validateTargetUrl("https://other.test/start", config).ok).toBe(false);
  });
});
