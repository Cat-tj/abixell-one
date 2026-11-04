import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Every integration suite bootstraps tenants against the same dev database,
    // and vitest runs the files in parallel. The default 10s hook timeout is
    // shorter than a bootstrap under that contention, so unrelated suites fail
    // with "Hook timed out" depending on which workers happen to collide. Each
    // suite passes in isolation; this only stops the shared-database race from
    // deciding the result.
    hookTimeout: 30_000,
    // Same shared-database contention applies to individual tests that
    // bootstrap tenants mid-suite (default 5s). 15s covers a contended
    // database without hiding real hangs.
    testTimeout: 15_000,
  },
});
