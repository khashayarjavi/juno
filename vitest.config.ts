import { defineConfig } from "vitest/config";

// Unit tests: fast, no Docker. `npm run test:watch` gives watch mode.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/lint/**/*.test.ts", "test/evidence/**/*.test.ts"],
  },
});
