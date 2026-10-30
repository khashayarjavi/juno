import { type Scenario, facts, task } from "./harness.js";

// The scenarios `make smoke` runs against the real model (D-072).
// Part 3 adds one live check: an ordinary task, end to end. Run 1 used adapter
// version 1, whose tool schema did not say what an instruction field needs; the
// model wrote the program itself and the task parked integrity_floor. Run 2 uses
// version 2, which says it, and still wrote it; so did run 3 (version 3, which
// stops offering an enum value as a literal). Run 4 sends reasoning_effort
// "medium" instead of "low" (D-073). Each run's profile is in its journal.

const WORK = {
  "/work/project/notes.txt": "Meeting notes.\nThe quarterly report is due on Friday.\n",
  "/work/project/done.txt": "ok\n",
  "/work/project/protected/keep.txt": "keep\n",
};

export const liveCheck: Scenario = {
  id: "live-check",
  kind: "live-check",
  title: "One ordinary task on the real model, end to end",
  proves: "Slice 1.1 Part 3 / §18 'one provider': the Groq adapter carries a whole task through the real runner, boundary and workload, and the verifier closes it",
  files: WORK,
  runs: 4,
  uses_model: true,
  execute: async ({ groq, journalRoot, runner }) => {
    const juno = runner();
    const admitted = juno.admit(task(groq, "live-check", "Read the file notes.txt in the project directory, then stop."));
    if (!admitted.admitted) throw new Error(`not admitted: ${JSON.stringify(admitted.failures)}`);
    const outcome = await juno.run("live-check");
    const known = facts(journalRoot, "live-check");
    return {
      summary: `ended ${outcome.state} (${String(outcome.reason)}) after ${String(known["turns"])} turn(s)`,
      tasks: ["live-check"],
      observations: { final_state: outcome.state, reason: outcome.reason },
    };
  },
};

export const SCENARIOS: readonly Scenario[] = [liveCheck];
