import { defineConfig } from "vitest/config";

// Container tests: need Docker and the images built by `make containers`.
// Run only by the container stage of `make verify`. The §18 acceptance tests
// (test/acceptance) run here too, against the real containers.
export default defineConfig({
  test: {
    include: ["test/containers/**/*.test.ts", "test/acceptance/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
