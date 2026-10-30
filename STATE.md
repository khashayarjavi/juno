# STATE

## Current increment
7 — Acceptance

Branch: `claude/tender-allen-hvjegb`, fast-forwarded to `main` after PR #9 merged. Increments 5 and 6 are in `main`.

**Status: done (all five §18 tests pass end to end; `make verify` green); pending review and the §7 merge gate.** Plan, all five steps done (D-067):
1. Carry-over from the PR #9 review: TTL is judged before the non-overridable check on resume, so an expired task parked `integrity_floor` goes to `failed` (§6.4).
2. Discovery program for test 3: `/usr/bin/ls` in the workload image (its two libraries copied in, arch-neutral) and in the `shell.run` enum with a declared, code-free flag surface (D-029's forward record).
3. D-057 / D-025 Inc 7: every criterion names protected paths; the verifier records a listing of them at start and fails verification if it changed.
4. A plain-text account of a task built from its journal alone (test 1).
5. The five §18 tests end to end in `test/acceptance/`, against the real containers; tests 2 and 3 in one run.

Done: `test/acceptance/acceptance.test.ts` (6 tests: tests 2+3 together, 1, 4a, 4b, 5, and the protected-path write). `test/containers/runner.test.ts` now also expects the two protected listings of a verified task (it asserts more than before, nothing less). `test/containers/registry.test.ts` gains the ls ownership test.

- **First independent review of PR #10 (head ecc0b3f): DO NOT MERGE.** Fixed on the next head:
  - a protected-path listing that did not run could compare equal to a failed baseline and pass; now a failed baseline fails the task and a failed check is `inconclusive`;
  - a task whose first listing parked could never finish; the baseline is now taken on resume;
  - the modification-time residual and the listing's working directory are recorded in D-067.
  Three tests added; each fails when its fix is removed.

## Merges recorded (CLAUDE.md §7 step 6)
- **Increment 6, PR #9** (https://github.com/khashayarjavi/juno/pull/9): head 61d2aa34247ef06ef10ba859733da8fc941d021a; PR CI `verify` run 41067106637 (success); merged as merge commit e38850156b70ad7e80537589ff77a74b35259b9a, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41067673749 (workflow_dispatch, success). Reviewer verdicts: round 1 DO NOT MERGE on add00fe (four findings, all fixed), round 2 MERGE on 61d2aa3 (one minor carry-over, plan step 1).
- **Increment 5, PR #8** (https://github.com/khashayarjavi/juno/pull/8): head fd68a2509d0be8556754cc3a0e78d71dfcad28e6; PR CI `verify` run 41063185508 (success); merged as merge commit da4e4cf32f6e8a5acd8e84dbc71c8afd2ca04c71, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41064280256 (workflow_dispatch, success). Reviewer verdicts: round 1 MERGE on 4e00d36 (findings fixed), round 2 MERGE on fd68a25.
  - The CI workflow runs on pull requests and `workflow_dispatch` only, so step 6d dispatches it on `main` (the workflow file is unchanged).

## Increment 5 (merged) — summary
Everything is in `packages/runner/` unless named. Every test names the section it proves.
- **Operator change first (D-055):** `CLAUDE.md` §7 Autopilot, and rules 11 to 13 in §2. Standing rulings recorded: D-056 (Increment 6: a journal that fails verification after a crash is never resumed), D-057 (Increment 7: protected paths; tests 2 and 3 pass together), D-065 (the runner runs on the host; no Docker socket in any container).
- **Rule 12 check (D-058):** `tools/check-unicode.js` refuses invisible and bidirectional-control characters in source, tests, capability files and configuration. `make lint` runs its self-test (twelve planted characters must all be found) and then scans the repository. `test/lint/unicode.test.ts` checks each class.
- **Provider (D-059):** `provider.ts` (`Provider` interface, `ProviderResponse` parsed at the boundary, `ScriptedProvider`), `profile.ts` and `providers/scripted.json` (the one Provider Capability Profile, §13.1).
- **Admission (D-061):** `admission.ts`. §5.4 checks 1 to 11, all failures reported together. Derives `context_ownership` (always `native` in Slice 1) and `steer_capability` (§7.8 table), records `criterion_integrity` (operator, or `derived` for a model-drafted criterion), lowers `closure_mode` to `accepted` when `verified` is not licensed, builds the constants table (operator constants, and the criterion's literals at the criterion's integrity), and routes to a provider. Also enforces §5.3 (capped grants for write-class capabilities; no grant over the whole `/work` namespace) and check 4 for grants (everything a grant reaches lies within a classified source).
- **Tool-call translation (D-060):** `translate.ts`. `{"ref": ...}` is bound, `{"slot": ...}` constant, any other literal synthesized; nothing the model writes becomes an argument source.
- **Turn loop (D-063):** `runner.ts`. Assemble, call the provider, journal the turn (request, its hash, model and version, cost), hand each proposed call to the enforcement boundary, `perform` only what it authorizes, journal the result, repeat. The runner never invokes or plans a capability itself.
- **Parks:** `awaiting_grant`, `integrity_floor`, `scope_violation`, `sensitivity_ceiling`, `adapter_quarantined` (from the boundary), `budget_exceeded`, `routing_unavailable`. Each `park` entry records `overridable` (false for `integrity_floor` and `adapter_quarantined`, §8.3). TTL expiry moves the task to `failed` with `ttl_expired` (§6.4).
- **Budgets (D-063):** `budget.ts`. All four axes, each parking on its own. Wall clock counts running time only.
- **Verification and closure (D-062):** the model's "done" triggers the criterion's command through the boundary; `pass` writes the closure (`juno.verifier`) and moves to `verified`; otherwise `failed`, no closure. Non-verified tasks go to `complete_unverified`; the principal may `accept`. The closure is checked against every executing actor at write time.
- **Sensitivity floor:** raised by every result (to the sources' class), recorded by a `note`.
- **One runner per journal, and quarantines across restarts (D-064):** `lock.ts`; the `juno.registry` record.
- **Registry:** one read accessor added, `CapabilityRegistry.capabilities()` (the tools offered to the model).
- **Tests:** `packages/runner/test/runner.test.ts`, `admission.test.ts` (73 tests), and `test/containers/runner.test.ts` (6 tests: a real task in the real workload, closed verified; the workload cannot read or write the host journal by its exact paths; the journal is byte-for-byte unchanged; no container has the Docker socket).
  - The four build plan tests: no criterion admits non-verified; a model-drafted criterion is `derived` and never closes verified; each budget axis parks on its own; a closure verified by an executing actor (model, runner, boundary or adapter) is refused by the schema at write time.
  - The STATE requirement from Increment 4: a whole task runs with a registry whose `invoke` throws, and no runner module calls `invoke`, `plan` or `executeOutbound`.
- **Mutation-checked:** 10 deliberate breakages; 8 caught. The 2 survivors (the clock not stopped on park or on a state change) are equivalent: `run()` always stops the clock when it returns.

- **First independent review (2026-10-30, head 4e00d36): MERGE**, with small findings, all fixed before merging (new head below):
  - a source-shaped object the model wrote, nested exactly 16 list levels deep, reached the boundary unwrapped (off by one in `translate.ts`); fixed, and a test nests a forged constant 1 to 20 deep (it fails on the old code at 16) (D-060);
  - a refused closure left the task `running`; it now ends `failed` / `closure_refused` in the trajectory (D-062);
  - a test comment said the opposite of its assertion; fixed, and the positive case added;
  - the provider-response limits were unrecorded (D-059); a runner now runs one task at a time (D-063).
  - The reviewer also asked the operator to confirm that the CLAUDE.md §7 autopilot change (D-055) is theirs. It came from the director's instruction that started this session.

- **First independent review of PR #9 (2026-10-30): DO NOT MERGE.** Fixed: (1) the four Increment 6 commits had not reached GitHub (the branch's upstream had become `origin/main`; pushed, upstream fixed); (2) a resume that re-parked left the runner claimed, so it refused all further work (fixed, tested); (3) a task listing an unusable grant could never resume (operator can now drop grants on resume, recorded in D-066 with the consequence; tested, including across a restart); (4) the runner-record classes recorded in D-066.

## Remaining in Increment 6
- `make verify`, review and the §7 merge gate.

## make verify
GREEN as of 2026-10-30 (Increment 7, after the first-review fixes): 634 unit tests (18 files), 51 container and acceptance tests (7 files), both lint self-tests fired. Summary line: `make verify: GREEN`.

## For the operator
- **PR #7 (superseded, still open):** https://github.com/khashayarjavi/juno/pull/7 is an earlier Increment 5 from another session (branch `claude/great-keller-clbbvy`). This session missed it at the start (§7 step 1 says to continue an open PR) and built Increment 5 afresh as PR #8, which is merged. Checked against `main`: PR #7's two operator rulings (TTL expiry fails the task, never a park; no default budget ceiling) are both honoured by the merged code (D-063; the admission schema requires all four axes). Its D-065 proposal is the one the director ruled on (D-065 here). Its other choices were agent decisions, and some differ from the merged ones (for example, it took over a stale runner lock where D-064 refuses to). PR #7 was not closed by this session; closing it is the operator's call.

## Open objections to the spec
- None.

## Notes for the next session
- **Increment 6 (resume)** must: rebuild a task's state (task record, spend, grants' invocation counts) from the journal — the admission note holds the full Task, each `capability_call` names the grant charged, each `turn` holds its cost; re-evaluate grants, `model_policy` and `sensitivity_floor` on resume (§6.3); never resume a task whose journal fails verification (D-056); keep TTL counting parked time (D-025). Today the runner keeps tasks in memory, and `run` starts only an `admitted` task.
- **Increment 7 (acceptance):** D-057 (protected paths in every criterion; tests 2 and 3 together). Test 3 needs a discovery program (for example `ls`) in the enum and the workload image (D-029), with bound names after `--` (D-037); `stdout_lines` in a `capability_result` is what a reference binds (D-060). Test 3's program must be a constant or a bound reference to an `attested`-or-better entry. Test 4b must decide how the forced enum entry is registered.
- **Runner on the host (D-065):** `test/containers/runner.test.ts` is the pattern: the `Runner` class runs on the host with `WorkloadExecFileAdapter`. `providers/scripted.json` is read from the source tree; a dist build would need it copied.
- Accepted residual (D-047): symlinks are not resolved in scope checks; must be built before JUNO operates on content it did not create (Slice 1.5).
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. This cloud host runs cgroup v1; CI runs v2. The CPU-limit test needs at least two host CPUs (D-030, D-039).
- `docker compose run` attaches stdin; anything that runs a program through it must close stdin (D-033).
- No `npm install` in Dockerfiles (D-001).
