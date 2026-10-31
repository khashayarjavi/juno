import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileTokenLedger, GroqProvider, takeGroqKey } from "../../packages/runner/src/groq.js";
import { GROQ_PROFILE_FILE, loadProviderProfile } from "../../packages/runner/src/profile.js";
import { EARLIER_LEDGERS, type RunRecord, evidenceRoot, recorded, runDir, runScenario, teardown } from "./harness.js";
import { SCENARIOS } from "./scenarios.js";

// `make smoke` (Slice 1.1; DECISIONS.md D-002, D-072, D-073). Run from the
// cloud session only: it refuses to run in CI. The key is taken out of the
// environment before anything else runs, so no child process inherits it.
// `JUNO_SMOKE_ONLY` (comma-separated scenario ids) narrows the run.

/** Below Groq's documented free daily limit of 200K tokens for the model, in a rolling 24 hours (D-072). */
const TOKEN_CAP = 180_000;

it("runs the smoke scenarios on the real model", { timeout: 6 * 60 * 60 * 1000 }, async () => {
  if (process.env["CI"] !== undefined || process.env["GITHUB_ACTIONS"] !== undefined) throw new Error("make smoke never runs in CI (D-002, D-072)");
  const key = takeGroqKey(process.env);
  mkdirSync(evidenceRoot, { recursive: true });
  const ledger = new FileTokenLedger(join(evidenceRoot, "token-ledger.jsonl"), TOKEN_CAP, EARLIER_LEDGERS);
  const groq = new GroqProvider({ profile: loadProviderProfile(GROQ_PROFILE_FILE), key, ledger });
  const only = (process.env["JUNO_SMOKE_ONLY"] ?? "").split(",").filter((id) => id.length > 0);
  const records: RunRecord[] = [];
  const started = Date.now();
  try {
    for (const scenario of SCENARIOS.filter((item) => only.length === 0 || only.includes(item.id))) {
      for (let index = 1; index <= scenario.runs; index += 1) {
        if (recorded(scenario, index)) continue;
        const record = await runScenario(scenario, index, groq, key);
        // A STOP inside the provider parks the task, so the run did not finish on the model's own account. It is kept
        // aside (never counted, never skipped) and runs again next session; the whole smoke run ends here.
        if (groq.stopped !== null) {
          renameSync(runDir(scenario, index), `${runDir(scenario, index)}-stopped-${new Date().toISOString().replace(/[:.]/g, "-")}`);
          throw groq.stopped;
        }
        records.push(record);
        process.stdout.write(`smoke: ${scenario.id} run ${String(index)}: ${record.passed ? "checks hold" : "CHECK FAILED"}; ${record.summary}\n`);
      }
    }
  } finally {
    await teardown();
    const used = ledger.used(Date.now());
    writeFileSync(
      join(evidenceRoot, "last-smoke.json"),
      `${JSON.stringify({ started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(), runs: records.map((record) => `${record.scenario}/run-${String(record.run)}`), tokens_last_24h: used, token_cap: TOKEN_CAP, stopped: groq.stopped === null ? null : groq.stopped.message }, null, 2)}\n`,
    );
    process.stdout.write(`smoke: ${String(used)} tokens in the last 24 hours (cap ${String(TOKEN_CAP)})\n`);
  }
  expect(records.filter((record) => !record.passed).map((record) => `${record.scenario}/run-${String(record.run)}`)).toEqual([]);
});
