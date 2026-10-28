# STATE

## Current increment
1 — Contracts and the lattice

Branch: `inc-1-contracts-lattice`. Draft PR: https://github.com/khashayarjavi/juno/pull/3 (stays draft until O-1 is ruled on). Increment 0 is in `main` (its commits reached `main` through PR #2).

**Status: not done. One objection (O-1) is open.** Everything else in the increment is built, tested and green. The one piece left is the accept half of the grant attenuation check, which depends on how the operator rules on O-1.

## Done in this increment
All in `packages/contracts` (pure, no I/O). Every test names the spec section it proves.
- **Lattice (§1.1–1.2)** — `lattice.ts`. Sensitivity and integrity are ordered enums, and `join` takes max sensitivity and min integrity. Property-based tests (fast-check, D-023) show join is commutative, associative, idempotent, independent of input order, composes over concatenation, and is monotonic in the right direction on both axes. Commutativity and associativity are also checked on every one of the 16³ triples. `join` refuses empty input (D-015).
- **Task `sensitivity_floor` cannot decrease (§3.1)** — `raiseSensitivityFloor` never lowers the floor (property test), and `assertSensitivityFloorTransition` refuses every lowering pair (all 16 pairs checked).
- **Field roles (§2.2)** — `capability.ts`. A field with no declared role parses as `instruction`. A `list` or `map` `instruction` field fails to parse, and so does a list field with no role, because it defaults to `instruction`. An invalid or misspelt role is an error, never a fallback (D-016, D-017).
- **Contracts as types and runtime schemas** — Task (§3.1), Capability (§2.1), Grant (§3.2), TrajectoryEntry (§3.4.2), Closure (§3.4.4), Artifact (§3.5). Shapes the model leaves open are in D-020 to D-022. The closure schema refuses `verified` unless the criterion is `operator` integrity and the check passed, and `closureSchemaFor` refuses a verifier equal to the executing actor.
- **Provenance classes and the `${<seq>.<path>}` grammar (§2.6, O9)** — `provenance.ts`, `reference.ts`. The parser rejects cross-task, ambiguous and unresolvable forms, each with its reason, and rejects any text around a reference. A round-trip property test shows every reference prints as readable text and parses back unchanged (D-019).
- **Interpreter test (§2.3)** — `interpreter.ts`. A predicate over a program name plus its declared flag surface. Every program on the spec's list is an interpreter, including `sh` and `git`, and so is any program with a code-bearing argv position. A program with no declared surface fails closed (D-018).
- **Grant attenuation, the unambiguous half (§3.2)** — `attenuation.ts`. It compares a child grant with its parent on seven dimensions and refuses any widening, including expiry extension (property-tested). Wildcard scope cannot be written at all, so §3.2's ban on wildcard egress scope holds by construction (D-020).
- **Mutation-checked:** 17 deliberate breakages (e.g. role defaulting to `data`, join using max integrity, expiry comparison reversed, cross-task detection off, self-verification allowed) each make tests fail.
- `scripts/session-start.sh`: a pid file whose PID now belongs to an unrelated process is treated as stale. This session, Docker would not start until the file was removed by hand.

## Remaining in this increment
- **Blocked on O-1:** the accept half of the attenuation check ("is grant B a valid attenuation of A"). Once the operator picks a reading, it takes about one function plus its tests. `attenuationViolations` already returns the rejections; what is missing is the rule for dimensions where the child equals its parent.
- After that: re-run `make verify`, mark the PR ready.

## make verify
GREEN as of 2026-10-28 in the cloud session: 232 unit tests (9 files), 14 container tests, lint self-test rejected the `exec()` probe. Summary line: `make verify: GREEN`.

## Open objections to the spec
- **O-1 — §3.2 "a strict subset of its parent on every dimension" (grant attenuation).** The sentence can be read three ways, and they disagree on whether a child grant may *equal* its parent on a dimension:
  (a) **no wider on any dimension.** Equal is allowed everywhere, so an identical copy counts as an attenuation.
  (b) **no wider on any dimension, and narrower on at least one.** The grant as a whole is a strict subset.
  (c) **narrower on every dimension.** A single-capability grant could then never be attenuated, because its capability set cannot shrink without becoming empty. Nor could a grant whose bounds are already `(public, operator)`, or one whose principal is fixed.
  The build plan's test ("rejects any widening on any dimension, including expiry extension") holds under all three readings, and that part is done. No code declares a grant a *valid* attenuation until the operator chooses. Slice 1 has no delegation, so no other increment waits on this.
  **Operator decision needed:** (a), (b) or (c). Reading (c) appears unworkable for the reasons above.

## Notes for the next session
- If the operator has ruled on O-1: implement the accept rule in `packages/contracts/src/attenuation.ts`, cite the ruling in DECISIONS.md, add tests, run `make verify`, mark the PR ready. Do not start Increment 2 until the Increment 1 PR is merged.
- Items later increments must pick up (found while reading the spec for this one; none is an objection yet):
  - **Increment 2:** §3.2 says no selector may name journal storage. A `path` selector can currently name any absolute path, including the journal mount. Increment 2 must make the journal path unaddressable by construction (for example, path selectors only inside the work namespace) and test it.
  - **Increment 3:** §2.3 rule 2 (code-bearing argv positions promoted to `instruction`, needed for acceptance test 4b) needs per-position roles inside `argv`. The D-017 field-type language cannot express that yet. Increment 3 should extend it and record the decision. `interpreterVerdict` already returns which positions bear code.
  - **Increment 5:** §5.3 requires `max_invocations` for `write`, `external` and `irreversible` grants. It also says a whole-filesystem scope (`/`) needs an Override, and Override is out of Slice 1, so such a grant must be refused. Neither is enforced in the Grant schema, because both are issuance rules.
  - **Increments 5 and 6:** §18 and the build plan list `ttl_expired` among the "park on" reasons, but §6.4 and the Increment 6 test say TTL expiry moves the task to `failed`. §6.2's park-reason table has no `ttl_expired`. Raise this as an objection when that increment starts, if the text is still unclear then.
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. The hook now removes pid files whose PID is not a docker daemon.
- Increment 0 notes still apply: no `npm install` in Dockerfiles (D-001); the runner has `network_mode: none` until Increment 5 (D-013); `work-vol` ownership is Increment 2/3 work.
