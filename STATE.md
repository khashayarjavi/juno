# STATE

## Current increment
2 — Journal

Branch: `inc-2-journal`. Increment 1 is in `main` (PR #3 merged).

**Status: in progress.** Not done until `make verify` is green and the container tests below exist.

## Done in this increment
- `packages/journal`: per-task hash chain, content-addressed blob store, writer, read interface (plain functions). Unit tests for tamper, truncation, reordering, D-025 blob deletion.
- Path selectors confined to the capability namespace `/work`; the journal refuses any root overlapping it; the runner config refuses overlap too.

## Remaining in this increment
- Runner image: `/journal` directory owned by the runner user.
- Container tests: runner writes to `journal-vol`; workload read and write attempts fail; full-filesystem canary scan in the workload finds nothing.
- DECISIONS.md D-026, D-027. Full STATE.md update. `make verify`.

## make verify
Not yet run this increment. Unit tests: 313 passing.

## Open objections to the spec
- None. (O-1 was resolved by the operator as reading (a); see D-024.)

## Notes for the next session
- Once PR #3 is merged, Increment 2 (Journal) is current. Do not start it before the merge.
- **Operator directives in D-025 apply per increment.** Read D-025 at the start of Increments 2, 3, 5, 6 and 7 and build each directive into that increment's tests: Inc 2 chain hashes payload digests, never bytes (a deleted blob leaves the chain verifiable); Inc 3 fixed CPU, memory and process-count limits on the workload, each hit by a container test; Inc 5 one runner per journal volume; Inc 5–6 `ttl` counts wall time including sleep and parked time, `wall_clock` budget counts running time only; Inc 7 criteria name protected paths and verification fails on writes under them.
- D-024 defers charging a derived grant's invocations to its parent chain until delegation exists (D-006). Nothing in Slice 1 consumes a derived grant.
- Items later increments must pick up (found while reading the spec for this one; none is an objection yet):
  - **Increment 2:** §3.2 says no selector may name journal storage. A `path` selector can currently name any absolute path, including the journal mount. Increment 2 must make the journal path unaddressable by construction (for example, path selectors only inside the work namespace) and test it.
  - **Increment 3:** §2.3 rule 2 (code-bearing argv positions promoted to `instruction`, needed for acceptance test 4b) needs per-position roles inside `argv`. The D-017 field-type language cannot express that yet. Increment 3 should extend it and record the decision. `interpreterVerdict` already returns which positions bear code.
  - **Increment 5:** §5.3 requires `max_invocations` for `write`, `external` and `irreversible` grants. It also says a whole-filesystem scope (`/`) needs an Override, and Override is out of Slice 1, so such a grant must be refused. Neither is enforced in the Grant schema, because both are issuance rules.
  - **Increments 5 and 6:** §18 and the build plan list `ttl_expired` among the "park on" reasons, but §6.4 and the Increment 6 test say TTL expiry moves the task to `failed`. §6.2's park-reason table has no `ttl_expired`. Raise this as an objection when that increment starts, if the text is still unclear then.
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. The hook now removes pid files whose PID is not a docker daemon.
- Increment 0 notes still apply: no `npm install` in Dockerfiles (D-001); the runner has `network_mode: none` until Increment 5 (D-013); `work-vol` ownership is Increment 2/3 work.
