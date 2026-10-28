import js from "@eslint/js";
import tseslint from "typescript-eslint";
import juno from "./tools/eslint-plugin-juno/index.js";

export default tseslint.config(
  {
    ignores: ["dist/**", "build/**", "coverage/**", "node_modules/**"],
  },
  {
    // CLAUDE.md rule 8: the no-shell rule may never be disabled inline.
    // With inline config off, `eslint-disable` comments have no effect anywhere.
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.ts", "**/*.js", "**/*.mjs", "**/*.cjs"],
    plugins: { juno },
    rules: {
      "juno/no-shell": "error",
    },
  },
);
