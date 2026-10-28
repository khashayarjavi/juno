# STATE

## Current increment
4 — Enforcement boundary

Branch: `claude/laughing-lovelace-bj5e9m`. The session harness assigned this name and allows pushes only to it, so it is used instead of `inc-4-enforcement` (D-040, as D-028 did for Increment 3). Increment 3 is in `main` (PR #5 merged).

**Status: not done.** In progress. Two objections to the spec are open (O-3, O-4 below); the parts they touch are not built.

## Done in this increment
- (in progress — see the commits on this branch)

## Remaining in this increment
- Build the enforcement boundary (`packages/enforcement`) for everything the objections do not touch.
- After the operator rules on O-3 and O-4: build the grant `data_class_bounds` check and the scope check for string-typed data fields.

## make verify
Not run yet this session. Last result: GREEN on `main` (Increment 3, CI run 40737951667).

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
- Read O-3 and O-4 first. If the operator has ruled, record each ruling in DECISIONS.md and build it.
- Increment 4 calls `checkInstructionFloors` as §2.7 step 3, with integrity computed per argument by provenance class (§2.6), and records per-element `argv[<index>]` provenance on every `capability_call` (D-022, D-038).
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
