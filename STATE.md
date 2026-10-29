# STATE

## Current increment
4 — Enforcement boundary

Branch: `claude/laughing-lovelace-bj5e9m`. The session harness assigned this name and allows pushes only to it, so it is used instead of `inc-4-enforcement` (D-040, as D-028 did for Increment 3). Increment 3 is in `main` (PR #5 merged). Draft PR: https://github.com/khashayarjavi/juno/pull/6.

**Status: done, pending the operator's merge.** The operator ruled on O-3 and O-4 on 2026-10-29 (D-046, D-047). The independent review of PR #6 found one gap, and the operator ruled on it the same day (D-048). That ruling and the review's smaller items (D-049, D-050, D-051, the frozen Authorization) are built and tested. The second review found that step 3 could be bypassed by the shape of a value, for example `program: [cmd]`. The operator ruled on that the same day, and the three rulings are built and tested (D-052, D-053, D-054, D-048 amended). `make verify` is green (see below). The PR stays a draft; the operator merges.

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
- **After the independent review (2026-10-29)** — 10 more tests in `enforcement.test.ts` (80 in all), each naming what it proves:
  - **Integrity before resolution failures (D-048, operator ruling; §1.5, §8.3).** Step 3 now runs before any rejection except an unknown capability. A synthesized command string plus one broken data reference parks `integrity_floor`, with and without a grant. A broken reference in the `program` field is judged `untrusted` and parks `integrity_floor`. A broken data reference with every instruction value passing is still rejected `unresolved_argument`. Also shown: with the `cwd` reference broken, the argv is still read and an untrusted promoted element parks; with no program, every argv element is promoted; a grant's raised floor is judged before the rejection.
  - **No argument values is not below every ceiling (D-049).** Such a call's input is the producing turn's class.
  - **A path inside a map-typed field fails closed (D-050).** It is a `scope_violation` even when it lies in scope.
  - **Undeclared flags and scope (D-051).** `--x=/etc/passwd` skips the scope check only because it promotes the whole argv to instruction; from the model it parks `integrity_floor`.
  - **The Authorization is frozen**, with frozen copies of the call and invocation, so what `perform` runs cannot be changed after inspection.
  - 13 further deliberate breakages, each caught by a test.
- **After the second review (2026-10-29)** — 15 more tests in `enforcement.test.ts` (95 in all), each naming what it proves:
  - **Shape never outranks provenance (D-052, operator ruling).** Before the proposal's shape is checked, every value under an instruction field is judged at that field's floor (raised by any candidate grant), in any shape and at any depth. Proven by a property test: 300 random proposals, each with a synthesized or unresolved value somewhere under `program`, in random lists, maps and nesting. Each one gets random argv, cwd and extra fields, with or without broken references and with or without a grant. Every one parks `integrity_floor`; none is rejected or proceeds. Explicit tests cover `program: [cmd]`, `program: [<broken reference>]`, a map and nested lists, and a grant's raised floor on a wrapped value.
  - **A missing program means no declared surface (D-048 amended, operator ruling).** A synthesized `-c` with a broken `cwd` and no program field parks `integrity_floor`, with and without a grant. Every argv element is promoted.
  - **The planned command is copied exactly once (D-053, operator ruling).** A test adapter returns its command through getters: one command on the first read, a different one on every later read. The boundary reads each getter once. The first command is the one inspected, journalled, carried in the Authorization and run. When the first read is the interpolated command, that is what is judged, and the adapter is quarantined.
  - **The build decisions under these rulings (D-054).**
    - A value that states no provenance (a bare string, `null`) fails every floor. It never proceeds, even as data.
    - An argv that is not a list is promoted whole.
    - A program outside the enum has no declared surface, so its argv is promoted.
    - Keys that are not identifiers are named so they cannot collide.
    - Nesting deeper than 16 levels is one unprovenanced value.
  - **Two existing tests changed, neither weakened** (details in D-054):
    - "rejects a program outside the enum when its provenance meets the floor" now gives an operator-constant argv, so its claim still holds. Its old input (`/bin/sh` with a synthesized `-c`) is a new test that parks.
    - "parks a synthesized command string alongside a broken data reference" now also expects the promoted `argv[0]`.
  - 12 further deliberate breakages, each caught by a test. They were: only top-level instruction values judged (the reviewed bug: the property test and five explicit tests fail); maps not walked; depth limit wrong; unresolved instruction value not judged; unprovenanced value given integrity; missing program skipping the argv; a program outside the enum read with `cat`'s surface; an argv that is not a list left unjudged; the invocation re-read instead of copied; keys not bracketed; an unprovenanced data value let through. One more (the explicit non-`ProposedCall` rejection removed) is equivalent on its own, because step 3 already reports such a proposal as unparsed; with both removed, a test fails.
- Decisions D-040 to D-054 recorded. D-042 and D-045 are marked as amended by D-046; D-045's exception is extended by D-048 and D-052/D-054; D-048 is amended by the second-review ruling.

## Remaining in this increment
- The operator's merge of PR #6. Nothing else.

## make verify
PENDING — the session is running `make verify` on the second-review changes. Unit tests alone: 512 passed (14 files). CI `verify` passed on PR #6 before the review changes (run 40794657374, commit b8a48f0) and on the first review commit (run 40799040134, commit 4763e0c).

## Open objections to the spec
- None. O-3 was resolved as D-046 and O-4 as D-047 (operator, 2026-10-29).

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
