import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration suite — runs against a REAL database and creates, mutates and
 * deletes organizations in it. It must therefore never point at production: the
 * environment comes from `.env.test.local` / `.env.test` (never `.env.local`,
 * which holds production credentials), and globalSetup refuses to continue if
 * the target still looks like production. See docs/TEST-ENVIRONMENTS.md.
 *
 * Single-file concurrency: migrations and seeds must not race.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/integration/setup.global.ts"],
    setupFiles: ["tooling/scripts/load-env-integration.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
