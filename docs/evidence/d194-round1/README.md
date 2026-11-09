# D-194: the entry-point test, run on round 1's code

Operator ruling D-193 asked for a test that fails if any service or session entry point skips the shared start-up check
or the shared session layer, and to "show it failing on the round-1 code".

- **Round 1's reviewed head:** `4fc2675` (PR #45, review round 1, DO NOT MERGE).
- **How it was run:** a detached worktree at `4fc2675`, with two files added and nothing else changed:
  - `round1-registry.ts.txt`: the registry, written as data describing the entry points that exist at `4fc2675`, with
    the same ids as the branch's registry (`packages/runner/src/entry-points.ts`).
  - `entry-points.round1.test.ts.txt`: part A (the source scan) copied verbatim from the branch's
    `packages/runner/test/entry-points.test.ts`; parts B and D for the gateway, the branch test's probes with the same
    arrangements and assertions, adapted only to round 1's constructor and io shapes (round 1 has no session layer).
- **Result (`output.txt`): 9 of 10 fail.**
  - Round 1's two findings, found by behaviour:
    - `gateway.serve` exits 0, serving, with the journal inside the workspace, and with the workspace holding all of
      JUNO's state (finding 2, D-148's mechanism).
    - The gateway parks no `rejection_limit` after three rejections, and a call to an undefined tool is not counted
      against the budget (finding 1).
  - Structural, found by the source scan: `gateway-cli.ts` and `main.ts` open the journal themselves; no class calls
    `SessionLayer.require`; nothing opens a session layer; `juno.ts` dispatches by hand; the runner process has no
    start-up function to register.
- **On the branch:** the same test passes, 50 of 50 (`npx vitest run packages/runner/test/entry-points.test.ts`).
