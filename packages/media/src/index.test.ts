import { describe, expect, it } from "vitest";
import { buildVideoFilter } from "./index.js";

describe("buildVideoFilter", () => {
  it("includes scaling and disclosure overlay when enabled", () => {
    const filter = buildVideoFilter({
      width: 640,
      height: 360,
      overlay: { enabled: true, label: "AI-assisted", sessionId: "abc123" }
    });

    expect(filter).toContain("scale=640:360");
    expect(filter).toContain("drawtext=");
    expect(filter).toContain("AI-assisted abc123");
  });

  it("omits drawtext when disclosure is disabled", () => {
    expect(buildVideoFilter({ overlay: { enabled: false } })).not.toContain("drawtext=");
  });
});
