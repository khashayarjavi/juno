# STATE

## Current increment
5 — Runner

Branch: `claude/great-keller-clbbvy`. The session harness assigned this name and allows pushes only to it, so it is used instead of `inc-5-runner` (D-056, as D-028 and D-040 did). Increment 4 is in `main` (PR #6 merged).

**Status: done, pending independent review and the operator's merge.** Every test the build plan lists for Increment 5 exists and names the section it proves. `make verify` is green. One item is for the operator to decide before Increment 7, not before this merge: how the containerised runner reaches Docker (D-065, recommendation given). Draft PR: https://github.com/khashayarjavi/juno/pull/7, left as a draft for independent review (runbook prompt 3).

## Done in this increment
All new code is in `packages/runner/` plus `packages/contracts/src/provider.ts`. No earlier package changed.
- **Provider Capability Profile (§13.1, D-057)** — `ProviderProfile` contract; the one provider is the scripted fake (`ScriptedProvider`, D-002), with its profile as configuration data in `packages/runner/providers/scripted-fake.json`. A provider's response is parsed at the boundary before use.
- **Admission (§5, D-058, D-059)** — `admission.ts`. Checks 1–11, each rejection recorded with its check number; `context_ownership` and `steer_capability` derived (§10.2, §7.8); `criterion_integrity` recorded from the criterion's author; `closure_mode` derived (`verified` only for an operator criterion with a method, otherwise `accepted`). **No default ceiling in code:** a missing budget axis (including spend) is a check-6 rejection. Also §5.3 (invocation cap for writing capabilities), `direct` strategy only, registered sources with declared classes (check 4). Every decision is journalled; a task id is never reused.
- **Turn loop (D-060, D-061)** — `runner.ts`. Assemble → call the provider → journal the `turn` → authorize → perform → journal the `capability_result` → repeat. The model's tool call becomes a proposal by shape: `{"ref": …}` is bound, `{"slot": …}` is constant, a bare value is synthesized (invariant 7). Rejections go back to the model; parks stop the task.
- **The runner reaches capabilities only through `authorize` then `perform`.** Proven two ways: every runner unit test uses a registry whose `invoke` throws (and counts calls: zero), and a test scans every runner source file for `.invoke(`, `.plan(`, `executeOutbound` and `child_process`.
- **Parks:** `awaiting_grant`, `integrity_floor` and every other park the boundary returns, plus `budget_exceeded`. **TTL expiry fails the task with `ttl_expired`; it is never a park (D-055).**
- **Budgets on all four axes (D-062, D-025):** checked before every turn (nothing left) and after every turn (overrun; that turn is not acted on). `wall_clock` counts running time on a monotonic clock; `ttl` counts wall time from admission, including sleep and parked time.
- **Verification and closure (§3.4.4, D-063):** when the model says done, the verifier runs the criterion's command through the boundary (every argument a constant fixed at admission). Pass → `verified` closure written by the runner; fail → `failed`, no closure; non-verified tasks → `complete_unverified`, which only the task's principal can close, and only as `accepted` (§6.1). `writeClosure` reads the task's executing actors from the journal at write time and the schema refuses a verifier equal to any of them.
- **One runner per journal volume (D-025, D-064):** a Unix-socket lock in the journal root. A second runner refuses to start; a crashed runner's stale socket is replaced. The container entrypoint takes the lock.
- **Tests** (`packages/runner/test/runner.test.ts`, 57 tests; `test/containers/runner.test.ts`, 2 tests). The build plan's four:
  - a task with no criterion admits as non-`verified`;
  - a model-drafted criterion carries `derived` integrity and cannot produce `verified` closure (by the runner, or by a direct write);
  - budget exhaustion on each axis independently parks the task (four tests, each naming only its axis);
  - a closure written with `verifier_identity` equal to the executing actor is rejected by the schema, and nothing is written.
  Also: every admission check; the §7.8 table; TTL → failed, never parked; ttl counts wall time while running time does not; wall time passing does not spend the wall-clock budget; awaiting_grant for a zero-grant task; integrity_floor for a synthesized program; a bound reference carried into argv; rejections reported to the model; the lock (second runner, killed holder, non-socket file). Container tests: a task runs to `verified` through the real workload container; a second runner container refuses to start while a first holds `journal-vol`, and one starts after the holder is killed.
- **Mutation-checked:** 17 deliberate breakages, each caught by a test (after-turn budget check removed; `>=` made `>`; ttl never expiring; failed verification not failing; currency not charged; running time not counted; a `ref` object with extra keys accepted; bare scalars left unprovenanced; executing actors not read; `verified` without method or operator criterion; budget axes unchecked; unclassified sources allowed; check 10 off; a §7.8 table row removed; the lock never refusing; a non-socket lock file replaced). The `ref`-with-extra-keys breakage first survived; a test case was added for it.
- Decisions D-055 to D-065 recorded.

## Remaining in this increment
- Independent review of the pull request, then the operator's merge.

## Decision needed from the operator (not a spec objection)
- **D-065 — how the containerised runner reaches Docker.** Needed before Increment 7 runs acceptance end to end. Options: (a) mount the Docker socket into the runner (root-equivalent on the host), (b) run the runner process on the host in Slice 1, (c) a restricted socket proxy. Recommendation: (b).

## make verify
GREEN as of 2026-10-29 in the cloud session: 569 unit tests (15 files), 40 container tests (6 files), lint self-test rejected the `exec()` probe. Summary line: `make verify: GREEN`.

## Open objections to the spec
- None.

## Notes for the next session
- **Next step:** once this increment's PR is reviewed and merged, Increment 6 (resume) is current. Do not start it before the merge.
- **Increment 6 must:** rebuild a task's state from the journal after a runner restart (the runner keeps tasks, usage, constants and grant counts in memory; the admission note holds the request and the admitted task, and every `capability_call` names the grant charged); re-evaluate grants, `model_policy` and `sensitivity_floor` on resume (§6.3), including §10.3's `routing_unavailable`, which D-061 left to resume; expire parked tasks by ttl (wall time since admission, D-062). A turn that overran a budget is journalled but was not acted on; resume must not act on it either.
- **Increment 7:** acceptance needs the D-065 decision. Criteria in Slice 1 are a command plus an exit code (D-063); D-025's protected-paths rule will need the criterion to grow, as a reviewed change.
- **Accepted residual, with a gate (D-047):** scope is judged on the path as written. A symlink already present in the work content can reach outside the scope. Resolving symlinks (§3.3's canonical form) must be built **before JUNO operates on any content it did not create (Slice 1.5)**, not only when a link-creating program is admitted.
- **Acceptance test 3 consequence:** `program` is an instruction field at the `attested` floor. A model-typed program is `synthesized` and therefore `untrusted` under native context, so it parks. Test 3 (Increment 7) must give `program` as a constant or as a bound reference to an `attested`-or-better entry.
- **Acceptance test 4b consequence:** the boundary works on registered capabilities, and registration refuses `sh`. Increment 7's end-to-end 4b must decide how the forced entry is registered (for example a test-only path that skips review), and record it.
- Grant invocation counts and quarantines live in memory (D-042, D-044). Increment 6 must keep grants and counts across a runner restart; the `capability_call` entries name the grant charged, so counts can be rebuilt from the journal.
- Items carried from Increment 3 that later increments must pick up:
  - **Increment 7 (with D-065):** `packages/registry/definitions/` and `packages/runner/providers/` are not copied into the runner image; whichever D-065 option is chosen must ship them where the runner registers capabilities at start.
  - Settled in Increment 5: `/work` is not "whole-filesystem" and §5.3's cap rule is checked at admission (D-058); TTL expiry is `failed`, never a park (D-055).
  - **Increment 6:** a crash between writing a journal entry and replacing the head leaves the chain failing verification (fails closed, D-027). No recovery is built.
  - **Increment 7:** acceptance test 3 needs a discovery program (for example `ls`) in the enum and the workload image (D-029), with bound file names after `--` (D-037).
- Read D-025 at the start of Increments 5, 6 and 7.
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. This cloud host runs cgroup v1; CI runs v2. The CPU-limit test needs at least two host CPUs (D-030, D-039).
- `docker compose run` attaches stdin; anything that runs a program through it must close stdin (D-033).
- Increment 0 notes still apply: no `npm install` in Dockerfiles (D-001). The runner container still has `network_mode: none`: the scripted provider needs no network (D-002), so none was opened in Increment 5 (D-013).
