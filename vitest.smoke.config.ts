import { defineConfig } from "vitest/config";

// `make smoke` only (DECISIONS.md D-002, D-072): the evidence run against the
// real provider. Never part of `make verify` or CI.
export default defineConfig({
  test: {
    include: ["test/smoke/**/*.smoke.ts"],
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
