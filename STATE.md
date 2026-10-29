# STATE

## Current increment
4 — Enforcement boundary

Branch: `claude/laughing-lovelace-bj5e9m`. The session harness assigned this name and allows pushes only to it, so it is used instead of `inc-4-enforcement` (D-040, as D-028 did for Increment 3). Increment 3 is in `main` (PR #5 merged). Draft PR: https://github.com/khashayarjavi/juno/pull/6.

**Status: done, pending independent review.** The operator ruled on O-3 and O-4 on 2026-10-29 (D-046, D-047). Both rulings are built and tested, and `make verify` is green (see below). The PR stays a draft until the independent review the operator asked for; then the operator merges.

## Done in this increment
Every test names the spec section it proves. All of this is in `packages/enforcement/` (new), plus small additions to `packages/registry/src/registry.ts`, `packages/registry/src/entry.ts` and `packages/contracts/src/promotion.ts`.
- **The enforcement boundary (§2.7)** — `boundary.ts`. For each call a task proposes, it runs, in order:
  1. resolve bound references (step 1);
  2. compute each argument's provenance (step 2), and look up the candidate grants;
  3. `checkInstructionFloors` (step 3, D-038), then each candidate grant's raised floors;
  4. the grant check (`awaiting_grant`), decided only after step 3 passes;
  5. scope (step 4);
  6. sensitivity (step 5): the capability's ceiling, then each grant's lower one;
  7. adapter quarantine (step 6).
  Each step keeps the candidate grants the call meets, and the first step that leaves none decides the park. A call proceeds only when every check passes, under the first remaining grant in the task's order. That grant is charged and named in the journal. These are the build plan's "five checks": the grant check plus steps 3 to 6 (D-045, D-046).
  - Parks produced: `integrity_floor`, `awaiting_grant`, `scope_violation`, `sensitivity_ceiling`, `adapter_quarantined`.
  - Rejections (nothing runs, nothing is charged, the task keeps running): a reference that does not resolve, a constant slot never fixed, an unregistered capability, a call that does not parse (D-045).
  - A synthesized command string in the `program` field parks `integrity_floor` even when it is not a valid enum value (D-045). This matters for acceptance test 2.
- **Grant bounds (§3.2 `data_class_bounds`, D-046)** — a grant's `min_integrity` raises the floor of every instruction value (never a data field), and a breach parks `integrity_floor`. Its `max_sensitivity` lowers the step-5 ceiling, and a breach parks `sensitivity_ceiling`. A grant can never lower a floor.
- **Per-argument provenance (§2.6)** — `proposal.ts`. Each argument arrives labelled `constant`, `bound` or `synthesized`, and the label is never inferred from the value (invariant 7). Each argv element carries its own label (`argv[<index>]`). The integrity and sensitivity rules are in D-041.
- **Bound references (§2.6, §2.7 step 1)** — `binding.ts`. A reference resolves only against the calling task's own verified trajectory. Every resolution, resolved or rejected, is recorded, along with the candidate set when the same path matches other entries (D-043).
- **Grants (§3.2)** — `grants.ts`. Storage and lookup by principal, capability, issue time, expiry, revocation and invocation count. Only calls that proceed are charged (D-042).
- **Scope (§2.7 step 4, D-047)** — `scope.ts`.
  - `path` data fields (`cwd`) and every argv operand must lie inside a path selector of the grant.
  - Operands are read by the same D-037 reading that promotion uses (`argvTokenKinds`, one shared reader in `promotion.ts`), normalised against `cwd`, with `..` resolved as written. Flags are not resources.
  - Absolute paths and `..` escapes outside the scope park `scope_violation`.
  - Definitions now name their working-directory field (`cwd_field`). `shell.run.json` names `cwd`, a one-line reviewable change.
- **Runtime adapter observation and quarantine (§2.5, §2.7 step 6)** — `delivery.ts`, registry `plan` / `quarantine` (D-044).
- **The record (§3.4.2)** — every proposal leaves exactly one `capability_call` entry with per-argument provenance, values, origins, the verdict and the authorizing grant.
- **Performing the effect (§3.2)** — `perform` runs exactly the inspected invocation, once.
- **Build plan Increment 4 tests** (`packages/enforcement/test/enforcement.test.ts`, 70 tests). Each test the build plan lists exists:
  - a synthesized instruction value parks `integrity_floor` (§2.7 step 3);
  - a bound reference into a data field passes with the referenced entry's integrity (§2.6);
  - a literal matching a prior value is still `synthesized` (invariant 7);
  - a cross-task reference is rejected (§2.6, O9);
  - expired, revoked and over-count grants fail (§3.2).
  Added for the rulings:
  - grant floors raised, never lowered, never applied to data; the injected instruction never shown as a missing grant; grant ceilings; the choice among several grants; a property test over every combination of program integrity, turn sensitivity and grant bounds;
  - absolute, relative and `..` operands; flags exempt; text after `--` checked; a bound file name in scope; a property test that judges every operand by its normalised path.
  The contracts and registry tests cover the shared argv reader and `cwd_field`.
- **Mutation-checked:** 29 deliberate breakages from the first session plus 16 for the rulings, each caught by a test. The rulings' breakages: grant floor ignored, raised-floor park skipped, candidates not filtered by floors, the grant check moved before step 3, capability or grant ceiling skipped, scope filter skipped, argv operands unchecked, relative operands not read against `cwd`, `..` unresolved, path fields unchecked, prefix without a segment boundary, `cwd_field` unvalidated, `--` never ending options, subcommands read as operands, no-surface reading wrong. One further breakage (a grant floor allowed to lower a value's own floor) is equivalent and cannot be caught: step 3 already holds each value to its own floor first.
- Decisions D-040 to D-047 recorded. D-042 and D-045 are marked as amended by D-046.

## Remaining in this increment
- An independent review of the Increment 4 pull request (operator's instruction), then the operator's merge. Nothing else.

## make verify
GREEN as of 2026-10-29 in the cloud session, with D-046 and D-047 built: 487 unit tests (14 files), 38 container tests (5 files), lint self-test rejected the `exec()` probe. Summary line: `make verify: GREEN`. CI on PR #6 runs the same command on the pushed commit.

## Open objections to the spec
- None. O-3 was resolved as D-046 and O-4 as D-047 (operator, 2026-10-29).

## Notes for the next session
- **Next step:** once PR #6 is reviewed and merged, Increment 5 (runner) is current. Do not start it before the merge.
- **Accepted residual, with a gate (D-047):** scope is judged on the path as written. A symlink already present in the work content can reach outside the scope. Resolving symlinks (§3.3's canonical form) must be built **before JUNO operates on any content it did not create (Slice 1.5)**, not only when a link-creating program is admitted.
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
