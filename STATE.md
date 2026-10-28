# STATE

## Current increment
4 — Enforcement boundary

Branch: `claude/laughing-lovelace-bj5e9m`. The session harness assigned this name and allows pushes only to it, so it is used instead of `inc-4-enforcement` (D-040, as D-028 did for Increment 3). Increment 3 is in `main` (PR #5 merged).

**Status: not done.** Everything in Increment 4 that the spec settles is built and tested, and `make verify` is green. Two objections are open (O-3, O-4 below). The parts they touch are not built, and the increment cannot be done until the operator rules on them. Draft PR: https://github.com/khashayarjavi/juno/pull/6.

## Done in this increment
Every test names the spec section it proves. All of this is in `packages/enforcement/` (new) plus small additions to `packages/registry/src/registry.ts`.
- **The enforcement boundary (§2.7)** — `boundary.ts`. For each call a task proposes, it runs, in order: resolve bound references (step 1); compute each argument's provenance (step 2); `checkInstructionFloors` as step 3 (D-038, as the session prompt requires); the grant check; scope (step 4); sensitivity (step 5); adapter quarantine (step 6). The first failing check decides the park. A call proceeds only when every check passes. These are the build plan's "five checks": the grant check plus steps 3 to 6 (D-045).
  - Parks produced: `integrity_floor`, `awaiting_grant`, `scope_violation`, `sensitivity_ceiling`, `adapter_quarantined`.
  - Rejections (nothing runs, nothing is charged, the task keeps running): a reference that does not resolve, a constant slot never fixed, an unregistered capability, a call that does not parse. The spec says the runtime "rejects" bad references (O9) and gives no park reason for them (D-045).
  - A synthesized command string in the `program` field parks `integrity_floor` even when it is not a valid enum value. The defence fires on provenance, not on the value's shape (D-045). This matters for acceptance test 2.
- **Per-argument provenance (§2.6)** — `proposal.ts`. Each argument arrives labelled `constant` (a slot fixed at admission), `bound` (a `${seq.path}` reference) or `synthesized` (model text). The class is never inferred from the value (invariant 7). A list such as `argv` has one label per element, recorded as `argv[<index>]`. Integrity: constant = what admission fixed; bound = the referenced entry's; synthesized = `untrusted` under native context, `min()` over the volatile region under owned context. Sensitivity of a synthesized value is the producing turn's (D-041).
- **Bound references (§2.6, §2.7 step 1)** — `binding.ts`. A reference resolves only against the calling task's own verified trajectory, so it cannot reach another task. Every resolution, resolved or rejected, is recorded as a `binding_resolution` entry. When the same path also names a value in other prior entries, that candidate set is recorded (D-043).
- **Grants (§3.2)** — `grants.ts`. Grant storage and lookup. A grant covers a call only for the task's principal, a selected capability, after issue, before expiry, while unrevoked, and while invocations remain. Only calls that proceed are charged, to exactly one grant that holds the whole call (D-042).
- **Scope (§2.7 step 4)** — `scope.ts`. `path`-typed data fields (`cwd`) must lie inside a path selector of the grant. `argv` is not scope-checked yet (O-4).
- **Runtime adapter observation and quarantine (§2.5, §2.7 step 6)** — `delivery.ts`, registry `plan` / `quarantine`. Before a call runs, the boundary inspects the invocation the adapter planned. Every data value must be one whole argv element, and a list must arrive as consecutive elements in order. An adapter that passed the registration canary but interpolates real values, folds `cwd` into `--workdir=`, or throws on a valid call is quarantined. From then on every call to it parks `adapter_quarantined`, and `invoke` refuses it (D-044).
- **The record (§3.4.2)** — every proposal leaves exactly one `capability_call` entry carrying per-argument provenance, the values, their origins, the verdict and the grant. The chain verifies.
- **Performing the effect (§3.2)** — `perform` runs exactly the invocation that was inspected, once, and only for an authorization this boundary issued.
- **Build plan Increment 4 tests** (`packages/enforcement/test/enforcement.test.ts`, 45 tests):
  - A synthesized value in an instruction field parks `integrity_floor` (§2.7 step 3).
  - A bound reference into a data field passes with the referenced entry's integrity (§2.6).
  - A literal matching a prior value is still `synthesized` — no credit for coincidence (invariant 7), including as a property test.
  - A cross-task reference is rejected (§2.6, O9), and another task's entry cannot be reached by sequence number.
  - An expired grant fails (from the exact instant), a revoked grant fails, an over-count grant fails (§3.2).
  - Also: owned-context `min()`, promoted argv parking through the boundary (D-038), scope, sensitivity, quarantine, check order, the candidate set, single-use `perform`.
- **Mutation-checked:** 29 deliberate breakages of the boundary, grant store, binding, scope and delivery code, each caught by a test. They include: synthesized trusted, step 3 skipped, promoted argv dropped, the malformed-call fallback off, bound taking the synthesized class, owned `min()` dropped, grant / scope / sensitivity / delivery / quarantine checks skipped, the grant check moved before step 3, no charge, a reusable `perform`, candidates not recorded, rejected bindings not journaled, expiry inclusive, revocation / cap / issue time / principal / selector ignored, a future revocation waited for, structures accepted as values, prefix matching without a segment boundary, and list or scalar delivery unchecked.
- Decisions D-040 to D-045 recorded.

## Remaining in this increment
- **Waiting on the operator:** rulings on O-3 and O-4.
- After the rulings: build the grant `data_class_bounds` check (O-3, which may move the grant check before step 3) and the scope check for string-typed data fields such as `argv` (O-4). Record each ruling in DECISIONS.md, add tests, run `make verify`.
- Then an independent review of the Increment 4 pull request before merge (operator's instruction).

## make verify
GREEN as of 2026-10-28 in the cloud session: 454 unit tests (14 files), 38 container tests (5 files), lint self-test rejected the `exec()` probe. Summary line: `make verify: GREEN`. Green does not mean done here: O-3 and O-4 are open.

## Open objections to the spec

### O-3 — A Grant's `data_class_bounds` have no enforcement rule
§3.2 gives every Grant `data_class_bounds`: "Max sensitivity, min integrity permitted." No section says which values those bounds apply to, which check enforces them, or which park reason a breach produces. §2.7 checks only the **capability's** `min_argument_integrity` (step 3) and `max_input_sensitivity` (step 5), and §6.2 words `integrity_floor` and `sensitivity_ceiling` against the capability. Increment 4 implements §3.2, so it cannot be done while a grant field that limits authority is ignored, and the choice changes whether a park can be overridden.

Questions:
1. Which values does a grant's `min_integrity` bound: instruction values only (as §2.1 says for the capability), or every argument, data included? §2.2 says integrity never governs data.
2. Is a breach a reason the grant does not cover the call (`awaiting_grant`, overridable), or part of steps 3 and 5 (`integrity_floor`, not overridable; `sensitivity_ceiling`, overridable)?
3. So: must the covering grant be chosen before §2.7 step 3?

Options:
- **(a) Part of coverage.** A grant covers a call only if the call's aggregate input sensitivity is at or below its `max_sensitivity` and every instruction value is at or above its `min_integrity`. A breach parks `awaiting_grant`.
- **(b) Tightens steps 3 and 5.** Each instruction value's floor becomes the higher of its own floor and the grant's `min_integrity` (breach parks `integrity_floor`). The ceiling becomes the lower of the capability's `max_input_sensitivity` and the grant's `max_sensitivity` (breach parks `sensitivity_ceiling`). The grant is chosen before step 3. When several grants cover the call, the call proceeds under one whose bounds it meets.
- **(c) As (b), but `min_integrity` bounds every argument, data fields included.**

Recommendation: **(b).** It keeps §2.2.1's split (integrity governs instruction values, sensitivity governs inputs). Under §8.3's rule, an instruction value below a floor is an unobservable harm whichever object set the floor. Under (a), a Slice 2 Override of `awaiting_grant` would clear an integrity breach, which §8.3 forbids. (c) mixes two controls that §2.2 says are never mixed.

Until the ruling, the boundary looks grants up by principal, capability, issue time, expiry, revocation and invocation count, and does **not** apply `data_class_bounds`.

### O-4 — How `resource_scope` governs a string-typed data field such as `argv`
§2.2 says `data` fields are "governed by `resource_scope` on the Grant, and `max_input_sensitivity`", and names "an argv element" as data. §2.7 step 4: "Rejects if any `data` field falls outside the Grant's `resource_scope`." Scope selectors are path prefixes, repositories, `host:port` pairs and records (D-020). A `path` field (`cwd`) maps onto path selectors. `argv` is `list<string>`: a string has no selector kind, and an argv element may be a flag, a file name relative to `cwd`, an absolute path, or plain text. The spec does not say how a string is matched against a scope.

Both obvious readings break something:
- If strings are outside scope's reach, `shell.run(cat, ["/work/other/secret"], cwd="/work/project")` passes a grant scoped to `/work/project`. The §18 "path-scoped" grant would then govern only `cwd`.
- If a string must be shown to be inside the scope and cannot be, every call with argv parks `scope_violation`, and acceptance test 3 cannot pass.

A second, smaller question: §3.3 defines canonical resources (symlinks resolved) for locking. §2.7 step 4 does not say whether scope is judged on the path as written or on its canonical form.

Options for argv:
- **(a) Scope governs only `path`-typed fields** (and host-typed fields when one exists). String fields are governed by `max_input_sensitivity` only. What `argv` can reach is limited by the workload container (only `work-vol` is mounted), and that limit is written down as an accepted residual (§0.5).
- **(b) Every `data` argv element read as an operand is a path.** Under the D-037 reading of the program's surface, each element that is not a flag is normalised as a path (a relative one against `cwd`) and must fall within a path selector of the grant. Flags are not resources. Plain text resolves under `cwd`, so it passes whenever `cwd` does. An absolute path or a `..` escape outside the scope parks `scope_violation`.
- **(c) The surface declares which positions are paths** (a change to the definition format), and only those are scope-checked.

Options for symlinks: **(i)** judge the normalised path as written; **(ii)** resolve symlinks against the work volume first (§3.3's canonical form), and refuse a path that resolves outside the scope.

Recommendation: **(b) with (i) for Slice 1.** (b) needs no definition change, and it refuses absolute paths and `..` escapes. In Slice 1 no capability can create a symlink (the only program is `cat`), so (i) is safe now. (ii) becomes required when the first program that can create a link is admitted, and should be recorded as that program's condition.

Until the ruling, step 4 checks `path`-typed data fields (`cwd`) against the grant's path selectors, and does **not** check `argv` elements.

## Notes for the next session
- Read O-3 and O-4 first. If the operator has ruled, record each ruling in DECISIONS.md and build it in `packages/enforcement/` (O-3: `grants.ts` and the step order in `boundary.ts`; O-4: `scope.ts`).
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
