# STATE

## Current increment
6 — Resume

Branch: `claude/tender-allen-hvjegb`, moved forward to `main` after PR #8 merged (a fast-forward: it held only merged history). Increment 5 is in `main`.

**Status: done (build plan done-when met, `make verify` green); pending review and the §7 merge gate.** See D-066.

## Done in Increment 6
- `Runner.resume` (§6.3): never for an unverifiable journal (D-056) or a non-overridable park (§8.3); TTL first (§6.4, parked time counts); grants added while parked must pass admission's grant rules; every grant re-evaluated (any unusable grant re-parks `awaiting_grant`); model policy and floor re-evaluated against the providers served now (`routing_unavailable`); a `resume` entry records what was found.
- Rebuild from the journal alone after a restart: admission record, context notes, spend snapshots, floor notes, added grants. A task found still `running` fails `runner_interrupted`.
- Grant charges recorded in `juno.runner` before every effect and rebuilt at start; failed-unverifiable tasks recorded there too.
- `GrantStore.ids()` and `GrantStore.validity()` added (packages/enforcement/src/grants.ts); nothing else in the enforcement package changed.
- Tests: `packages/runner/test/resume.test.ts` (14), including both build plan tests (a grant that expires while parked re-parks on resume; TTL expiry while parked fails the task and releases it), with a control that the same task proceeds when its grants are valid. 13 deliberate breakages; 12 caught, 1 equivalent (the in-memory memo of an unverifiable task: the journal still fails, with the same outcome).

## Merges recorded (CLAUDE.md §7 step 6)
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
GREEN as of 2026-10-30 (Increment 6, after the first-review fixes): 628 unit tests (18 files), 44 container tests (6 files), both lint self-tests fired. Summary line: `make verify: GREEN`.

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
