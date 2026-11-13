# D-201: the restart property, run against the head before the fix

The operator's ruling D-201 asks for the restart property test to be shown failing on the head it was ruled on.

- **Head tested:** `2bbf936` (PR #49 after review round 2), in a separate checkout.
- **Test:** `packages/runner/test/restart.property.test.ts`, the file as committed with D-202, copied in unchanged.
- **Command:** `npx vitest run packages/runner/test/restart.property.test.ts`
- **Result:** 2 failed, 2 passed (`output.txt`, the first lines of the run and its summary).
  - **Hook mode: fails.** Smallest counterexample: admit a session, restart, admit the same session file again. With no restart the second admission is refused; after a restart it was accepted.
  - **Gateway mode: fails.** Smallest counterexample: one restart. The journal gains a second admission of the same session, with a fresh budget.
  - **Own loop: passes.** The runner already rebuilt its state from the journal (D-066); the finding was about the two newer modes.
  - The fourth test only checks that the generated sequences reach the limits; it passes.
- **On the head with D-202** all four pass (`make verify`).
