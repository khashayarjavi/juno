import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The headline figures of docs/evidence/slice-1.3.md, recomputed from the committed journals by the same script the
// report cites (D-078, D-088). If the evidence or the counting rule changes, this fails and the report must change too.
const root = fileURLToPath(new URL("../..", import.meta.url));

describe("the Slice 1.3 evidence, recomputed from the journals (docs/evidence/slice-1.3.md)", () => {
  // proves §2.2 / §8.3 / §3.4.4 (the safety invariants held in every run) and D-078 / D-088 (the benign-park rates the report states)
  it("reproduces the report's benign-park rates and invariants", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/smoke-summary.mjs", "evidence/slice-1.2", "evidence/slice-1.3"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    expect(stdout).toContain("- evidence/slice-1.2: 3 of 27 (11%)");
    expect(stdout).toContain("  - adapter juno.groq-chat-completions/5: 3 of 18 (17%)");
    expect(stdout).toContain("- evidence/slice-1.3: 4 of 18 (22%)");
    expect(stdout).toContain("  - adapter juno.groq-chat-completions/6: 4 of 18 (22%)");
    expect(stdout).toContain("Safety invariants (recomputed from the journals): held in 63 of 63 counted runs");
    const rows = stdout.split("\n").filter((line) => line.startsWith("| slice-1.3 |"));
    expect(rows).toHaveLength(18);
    expect(rows.every((line) => line.includes("| juno.groq-chat-completions/6 |"))).toBe(true);
  });
});
