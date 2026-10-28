# STATE

## Current increment
3 — Registry, adapters, and the conformance suite

Branch: `claude/inc-3-registry-ucto18`. The session harness assigned this branch name and allows pushes only to it, so it is used instead of `inc-3-registry`. Increment 2 is in `main` (PR #4 merged).

**Status: not done.** Objection O-2 blocks one part of this increment (per-position argv roles, §2.3 rule 2). The rest is being built.

## Done in this increment
- Objection O-2 written (below).

## Remaining in this increment
- Capability definitions as versioned files (`packages/registry`), `shell.run` with declared roles and an interpreter-free enum.
- Registration review: enum membership checked by the interpreter test (§2.3 rule 3, acceptance test 4a).
- Adapter: `execFile` across the container boundary, argv as an array.
- Registration conformance suite (§2.4): canary intact through a conforming adapter; a string-interpolating adapter blocked at registration (acceptance test 5).
- D-025 Inc 3 directive: fixed CPU, memory and process-count limits on the workload, each hit by a container test.
- `work-vol` ownership for the workload user (65532).
- **Blocked by O-2:** per-position argv roles (§2.3 rule 2).

## make verify
Not yet run on this branch.

## Open objections to the spec
- **O-2 — §2.3 rule 2 (per-position argv roles) is not settled by the spec.** Raised 2026-10-28 in Increment 3. Acceptance test 4b depends on it. §2.3 rule 2 says: "Where an interpreter is unavoidable, the code-bearing argv positions are promoted to `instruction` role, restoring the operator floor exactly where it belongs." The spec leaves three questions open:
  1. **It conflicts with §2.2 rule 2.** `argv` is `list<string>`. §2.2 rule 2 forbids an `instruction` role on a list "because whole-field `min()` over heterogeneous origins is ambiguous and per-element provenance would have to be invented", and says that where an operation seems to need one, "it needs a different capability decomposition". An `instruction` role on one element of `argv` is exactly a per-element role inside a list. The spec does not say whether §2.3 rule 2 is an exception to §2.2 rule 2 (so lists may carry per-element roles and per-element provenance), or whether "promotion" means something else.
  2. **It does not say what a "position" is or who fixes it.** In an interpreter, the code is not at a fixed index: `sh -c CODE`, `sh -e -c CODE`, `sh -cCODE`, `python script.py`, `find . -exec CMD ;`, `tar --use-compress-program=PROG`, `sed 's/x/y/e'` (the code flag sits inside an operand). Two readings fit the text:
     - (a) **Static.** The operator declares fixed argv indices as `instruction` in the capability definition. This keeps the trust root few and operator-authored (§0.5, §2.5). But code at an undeclared index (for example `sh -e -c CODE` when index 1 was declared) is not promoted.
     - (b) **Per call.** At each call, the enforcement boundary reads the argv against the program's declared flag surface (DECISIONS.md D-018) and promotes every element that carries code. This catches moved flags. But one element's role then depends on other elements the model wrote, and the boundary's reading of the argv must match the program's own option parser exactly, or the hole reopens.
  3. **It does not say which floor a promoted position gets.** §2.1 gives a capability one `min_argument_integrity`, which "applies to `instruction` fields". §2.2's illustration gives `program` the floor `attested`. §2.3 says promotion restores "the operator floor". With one value per capability, either `program` rises to `operator` or the promoted position gets only `attested`. The spec does not say whether floors may differ per field.
  - **Blocked until the operator rules:** per-position roles inside `argv` (an extension of the D-017 field-type language), and the mechanism acceptance test 4b needs. **Not blocked:** everything else in Increment 3. Nothing built here reads or writes argv roles per position. `interpreterVerdict` (Increment 1) already reports which declared positions carry code, so either ruling can be built on it.
  - **Requested from the operator:** rule on (1), choose (a), (b) or another reading for (2), and say for (3) whether a promoted position's floor is `operator` (per-field floors) or the capability's `min_argument_integrity`.

## Notes for the next session
- Read D-025 at the start of Increments 5, 6 and 7. The Inc 2 directive is done; the Inc 3 directive is built in this increment.
- Items later increments must pick up (none is an objection yet):
  - **Increments 4 and 5:** §3.3 canonicalization resolves symlinks. A resolved path outside `/work` must be refused, so a symlink inside the work volume cannot point a call at anything else.
  - **Increment 5:** §5.3 requires `max_invocations` for `write`, `external` and `irreversible` grants, and a whole-filesystem scope needs an Override (out of Slice 1). Increment 5 must decide whether `/work` counts as "whole-filesystem". If the spec text does not settle it, raise an objection then.
  - **Increments 5 and 6:** §18 and the build plan list `ttl_expired` among the "park on" reasons, but §6.4 and the Increment 6 test say TTL expiry moves the task to `failed`. Raise this as an objection when that increment starts, if the text is still unclear then.
  - **Increments 5 and 6:** a crash between writing a journal entry and replacing the head leaves that task's chain failing verification (fails closed, D-027). No recovery is built.
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. The hook removes pid files whose PID is not a docker daemon. This cloud host runs cgroup v1 with no swap; CI (`ubuntu-latest`) runs cgroup v2. Container tests must not depend on either.
- Increment 0 notes still apply: no `npm install` in Dockerfiles (D-001); the runner has `network_mode: none` until Increment 5 (D-013).
