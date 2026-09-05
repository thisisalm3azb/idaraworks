import { config } from "dotenv";
import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * H33 Pilot Lab test config — the isolation sweep and any other test that
 * needs the SEEDED five companies in the isolated test project.
 *
 * Loads `.env.test.local` explicitly (never `.env.local`); every test file
 * then calls the lab guard, which refuses anything that is not the test
 * project. Timeouts are generous: the sweep walks 257 tables over a remote
 * connection.
 */
config({ path: [".env.test.local", ".env.test"], quiet: true });

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/pilot-lab/**/*.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
