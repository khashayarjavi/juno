# STATE

## Current increment
2 — Journal

Branch: `inc-2-journal`. Increment 1 is in `main` (PR #3 merged).

**Status: done.** Every Increment 2 property holds under test, and `make verify` is green in the cloud session. Waiting for CI on the pull request and the operator's merge.

## Done in this increment
Every test names the spec section it proves.
- **Hash chain (§3.4.2)** — `packages/journal/src/chain.ts`. One chain per task, `seq` from 0. Each entry is one line of canonical JSON; its hash is the `sha256:` of that line, and the next entry's `hash_prev` is that hash. A head record names the last entry's `seq` and hash, so cutting entries off the end is detected (D-027).
- **Tamper, truncation, reordering are detected** — property tests: changing any single byte of the stored entries fails verification; cutting the entries at any byte fails; every reordering fails; a canonical rewrite of any field of any entry fails; changing the head fails; adding an entry without moving the head fails; a non-canonical but equivalent line fails. Each failure names its reason and line.
- **D-025 directive (Inc 2)** — the chain covers each payload's digest (`payload_ref`), never its bytes. Tests: deleting a blob leaves the chain verifiable and the reader is told `missing`; a changed blob is reported `corrupt` and its bytes are never returned; different payloads give different entry hashes.
- **Blob store** — `blobs.ts`. Payloads stored by content address; every read checks the bytes still match.
- **Writer** — `writer.ts`, used by the runner. Append-only (no update or delete). It assigns `seq`, `task_id`, `payload_ref`, `hash_prev` and `timestamp`, so a caller cannot forge them (tested by smuggling them into a draft). It checks every entry against the TrajectoryEntry contract and writes nothing on refusal. It refuses to append to a chain that fails verification.
- **Read interface (§3.4.1)** — `read.ts`: `readTrajectory`, `verifyTrajectory`, `readPayload`. Plain functions, not a Capability, with no capability id; a test checks that nothing the journal exports parses as a Capability. Entries are returned only when the whole chain verifies; readable while the task runs (tested after every append).
- **Journal path unaddressable by construction (§3.2, §3.4.1; the STATE.md item from Increment 1)** — D-026. Path selectors can name only `/work` and what is under it; `/`, `/journal`, `/etc`, `/workspace` fail at grant creation. The journal refuses any root overlapping `/work`; the runner refuses to start if `JUNO_JOURNAL_DIR` overlaps `/work` or `JUNO_WORK_DIR`. A property test checks that no journal root the journal accepts and no path selector the Grant schema accepts overlap in either direction (with a guard that hundreds of pairs were compared).
- **Containers** — the runner image creates `/journal` owned by the runner user, mode 0700. The runner opens the journal at start. Container tests: the runner (non-root) writes an entry to `journal-vol` and a second runner container reads it back verified; the workload's reads of the runner's exact journal paths fail, its writes fail, and a scan of every file it can read (about 1,300) finds no trace of the journal's canary, while finding a control marker it wrote itself; the journal is unchanged afterwards. Compose checks: `work-vol` is mounted in the workload at exactly `/work`; `journal-vol` is mounted nowhere inside `/work` in any service; the runner's `JUNO_JOURNAL_DIR` is the `journal-vol` mount.
- **Mutation-checked:** 18 deliberate breakages, each caught by a test: link, `seq`, canonical form, head seq/hash, missing head, task id and incomplete-line checks turned off; blob digest not checked on read; verification made to depend on blob bytes; journal root inside or containing `/work` accepted; path selector outside `/work` accepted, or checked without a segment boundary; both runner overlap checks off; writer appending to a broken chain; caller able to override chain fields; payload not stored.
- One unit-test fixture in `packages/contracts/test/grant.test.ts` changed from `/data` to `/work/data`, because the old path can no longer be written as scope. The property it serves is unchanged (D-026).

## Remaining in this increment
- Nothing. Waiting for CI `verify` on the pull request and the operator's merge.

## make verify
GREEN as of 2026-10-28 in the cloud session: 313 unit tests (10 files), 23 container tests (2 files), lint self-test rejected the `exec()` probe. Summary line: `make verify: GREEN`.

## Open objections to the spec
- None. (O-1 was resolved by the operator as reading (a); see D-024.)

## Notes for the next session
- Once the Increment 2 pull request is merged, Increment 3 (Registry, adapters, conformance suite) is current. Do not start it before the merge.
- **Operator directives in D-025 apply per increment.** Read D-025 at the start of Increments 3, 5, 6 and 7 and build each directive into that increment's tests: Inc 3 fixed CPU, memory and process-count limits on the workload, each hit by a container test; Inc 5 one runner per journal volume (the journal writer assumes it is the only writer; Increment 5 adds the refusal); Inc 5–6 `ttl` counts wall time including sleep and parked time, `wall_clock` budget counts running time only; Inc 7 criteria name protected paths and verification fails on writes under them. The Inc 2 directive is done.
- D-024 defers charging a derived grant's invocations to its parent chain until delegation exists (D-006). Nothing in Slice 1 consumes a derived grant.
- Items later increments must pick up (none is an objection yet):
  - **Increment 3:** §2.3 rule 2 (code-bearing argv positions promoted to `instruction`, needed for acceptance test 4b) needs per-position roles inside `argv`. The D-017 field-type language cannot express that yet. Increment 3 should extend it and record the decision. `interpreterVerdict` already returns which positions bear code. `work-vol` ownership (the workload runs as 65532) is also Increment 3 work.
  - **Increments 4 and 5:** §3.3 canonicalization resolves symlinks. A resolved path outside `/work` must be refused, so a symlink inside the work volume cannot point a call at anything else. The journal is still out of reach physically (the workload has no journal mount), but the check belongs in enforcement.
  - **Increment 5:** §5.3 requires `max_invocations` for `write`, `external` and `irreversible` grants. It also says a whole-filesystem scope needs an Override, and Override is out of Slice 1, so such a grant must be refused. Since D-026, `/` cannot be written as scope at all; the widest path scope is `/work`, the whole capability namespace. Increment 5 must decide whether `/work` counts as "whole-filesystem" for §5.3. If the spec text does not settle it, raise an objection then. Neither rule is enforced in the Grant schema, because both are issuance rules.
  - **Increments 5 and 6:** §18 and the build plan list `ttl_expired` among the "park on" reasons, but §6.4 and the Increment 6 test say TTL expiry moves the task to `failed`. §6.2's park-reason table has no `ttl_expired`. Raise this as an objection when that increment starts, if the text is still unclear then.
  - **Increments 5 and 6:** a crash between writing an entry and replacing the head leaves that task's chain failing verification (fails closed, D-027). No recovery is built. If acceptance test 1 (park, stop, resume next day) needs to survive an unclean stop, that is a decision for then.
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. The hook removes pid files whose PID is not a docker daemon.
- Increment 0 notes still apply: no `npm install` in Dockerfiles (D-001); the runner has `network_mode: none` until Increment 5 (D-013). Plain `RUN` in exec form (no network) is fine, as the runner image now does for `/journal`.
