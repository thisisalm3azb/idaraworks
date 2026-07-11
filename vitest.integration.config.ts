import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration suite — runs against a REAL database (hosted dev project locally,
 * Supabase local stack in CI). Single-file concurrency: migrations and seeds
 * must not race.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/integration/setup.global.ts"],
    setupFiles: ["tooling/scripts/load-env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
