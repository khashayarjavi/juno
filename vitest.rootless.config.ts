import { defineConfig } from "vitest/config";

// Rootless tests (DECISIONS.md D-130, D-131): run only by `make verify-rootless`, as the runner's
// unprivileged user against its rootless Docker daemon (scripts/rootless/run-verify.sh).
export default defineConfig({
  test: {
    include: ["test/rootless/**/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
