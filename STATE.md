# STATE

## Current increment
5 — Runner

Branch: `claude/great-keller-clbbvy`. The session harness assigned this name and allows pushes only to it, so it is used instead of `inc-5-runner` (D-055, as D-028 and D-040 did). Increment 4 is in `main` (PR #6 merged).

**Status: in progress (session 1).**

Plan for this increment (build plan Increment 5; spec §5, §6.1–6.2, §3.4.4, §7.8 derivation only):
- Provider Capability Profile contract (§13.1) and one provider adapter: the scripted fake (D-002), with its profile as a JSON file.
- Admission: checks 1–11, `context_ownership` and `steer_capability` derived, `criterion_integrity` recorded. No default spend ceiling: a missing budget axis is a check-6 rejection.
- Turn loop: assemble → call → authorize → perform → journal → repeat. The runner reaches capabilities only through `authorize` then `perform`.
- Parks: `awaiting_grant`, `integrity_floor` (and every other park the boundary returns), `budget_exceeded`. TTL expiry → `failed` with `ttl_expired`, never a park.
- Budgets on all four axes; `wall_clock` counts running time only, `ttl` counts wall time (D-025).
- Verification runs the criterion's command through the boundary; closure written by the runner, `verifier_identity` ≠ executing actor asserted at write time.
- One runner per journal volume (D-025).

## Done in this increment
- Nothing yet beyond reading and planning.

## Remaining in this increment
- Everything in the plan above.

## make verify
Not yet run on this branch. `main` was GREEN at the PR #6 merge.

## Open objections to the spec
- None.

## Notes for the next session
- **Next step:** once PR #6 is reviewed and merged, Increment 5 (runner) is current. Do not start it before the merge.
- **Increment 5 and the proposal shape (D-054):** the runner should always build `ProposedCall`-shaped proposals (one source per scalar field, one per list element). Anything else the boundary judges and then rejects `malformed_call`, or parks if it touches an instruction field. A runner bug that sends bare values therefore never runs, but it can park a task.
- **Accepted residual, with a gate (D-047):** scope is judged on the path as written. A symlink already present in the work content can reach outside the scope. Resolving symlinks (§3.3's canonical form) must be built **before JUNO operates on any content it did not create (Slice 1.5)**, not only when a link-creating program is admitted.
- **Increment 5 must reach the registry only through the boundary.** The runner may cause an effect only by `authorize` and then `perform` on the authorization it returns. It must never call `CapabilityRegistry.invoke` (or `plan` plus its own execution). Increment 5 must prove this with a test: for example, a registry whose `invoke` throws, with the runner's whole call path still working; or a check that no runner module calls `invoke`.
- **What Increment 5 must supply to the boundary** (D-041): the task (running), a constants table fixed at admission (each slot with its data class; integrity = the admitting source's), and the producing turn's sensitivity (plus the volatile region's integrities under `owned` context). It must turn the model's tool call into a proposal: a reference text becomes `bound`, a runtime-filled slot becomes `constant`, anything else becomes `synthesized`. It then calls `authorize`; on `proceed`, `perform`, then journals the `capability_result` using `authorization.input_class` for the §2.1 output class. On `park`, the runner writes the `park` entry and changes the task state. On `reject`, it tells the model.
- **Acceptance test 3 consequence:** `program` is an instruction field at the `attested` floor. A model-typed program is `synthesized` and therefore `untrusted` under native context, so it parks. Test 3 (Increment 7) must give `program` as a constant or as a bound reference to an `attested`-or-better entry.
- **Acceptance test 4b consequence:** the boundary works on registered capabilities, and registration refuses `sh`. Increment 7's end-to-end 4b must decide how the forced entry is registered (for example a test-only path that skips review), and record it.
- Grant invocation counts and quarantines live in memory (D-042, D-044). Increments 5 and 6 must keep grants and counts across a runner restart; the `capability_call` entries name the grant charged, so counts can be rebuilt from the journal.
- Items carried from Increment 3 that later increments must pick up:
  - **Increment 5:** `packages/registry/definitions/` is not copied into the runner image; the runner must copy it when it registers capabilities at start. The adapter calls the `docker` CLI (D-034); Increment 5 must decide how the runner, inside its container, reaches Docker.
  - **Increment 5:** §5.3 requires `max_invocations` for `write`, `external` and `irreversible` grants; a whole-filesystem scope needs an Override (out of Slice 1). Decide whether `/work` counts as "whole-filesystem"; raise an objection if the spec does not settle it.
  - **Increments 5 and 6:** §18 lists `ttl_expired` among the "park on" reasons, but §6.4 and the Increment 6 test say TTL expiry moves the task to `failed`. Raise this as an objection when that increment starts, if the text is still unclear.
  - **Increments 5 and 6:** a crash between writing a journal entry and replacing the head leaves the chain failing verification (fails closed, D-027). No recovery is built.
  - **Increment 7:** acceptance test 3 needs a discovery program (for example `ls`) in the enum and the workload image (D-029), with bound file names after `--` (D-037).
- Read D-025 at the start of Increments 5, 6 and 7.
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. This cloud host runs cgroup v1; CI runs v2. The CPU-limit test needs at least two host CPUs (D-030, D-039).
- `docker compose run` attaches stdin; anything that runs a program through it must close stdin (D-033).
- Increment 0 notes still apply: no `npm install` in Dockerfiles (D-001); the runner has `network_mode: none` until Increment 5 (D-013).
