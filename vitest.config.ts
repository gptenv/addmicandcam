import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node"
  }
});
