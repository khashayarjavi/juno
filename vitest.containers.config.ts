import { defineConfig } from "vitest/config";

// Container tests: need Docker and the images built by `make containers`.
// Run only by the container stage of `make verify`.
export default defineConfig({
  test: {
    include: ["test/containers/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
