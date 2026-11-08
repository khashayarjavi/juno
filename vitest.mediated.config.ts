import { defineConfig } from "vitest/config";

// The mediated end-to-end run with the real Claude Code binary (build plan Slice 1.5 §4; D-092, D-145): cloud sessions
// only, never `make verify` or CI. Run by `make mediated-e2e`.
export default defineConfig({
  test: {
    include: ["test/mediated-e2e/**/*.e2e.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
