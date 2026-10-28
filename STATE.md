# STATE

## Current increment
3 — Registry, adapters, and the conformance suite

Branch: `claude/inc-3-registry-ucto18`. The session harness assigned this name and allows pushes only to it, so it is used instead of `inc-3-registry` (D-028). Draft PR: https://github.com/khashayarjavi/juno/pull/5. Increment 2 is in `main` (PR #4 merged).

**Status: done.** Everything in the build plan's Increment 3 scope, the D-025 Inc 3 directive, `work-vol` ownership, and the operator's O-2 ruling (D-036) are built and tested, and `make verify` is green in the cloud session and in CI. CI `verify` passed on PR #5 (run 40736968183, commit 6a4a3c8). The next run (40737367665, commit 35d71d6, a STATE-only change) failed one control test: the unlimited CPU probe measured 1.28 CPUs, below the 1.5 required, on a busy shared runner. D-039 makes that control take up to three samples, with the 1.5 threshold unchanged; CI on that fix is pending. Waiting for the operator's review of `shell.run.json` and merge.

## Done in this increment
Every test names the spec section it proves.
- **Capability definitions as versioned files (§2.5)** — `packages/registry/definitions/shell.run.json`. `shell.run(program: enum, argv: list<string>, cwd: path)` with every role declared explicitly: `program` instruction, `argv` and `cwd` data. The program enum is interpreter-free and has one member, `/usr/bin/cat` (D-029). Each program has a declared flag surface. The format is in D-032. The definition's values are in D-035, and **the operator should review this file**: §2.5 requires definitions to be operator-authored, and the merge of this pull request is that act.
- **Registration review (§2.3 rules 1 and 3, acceptance test 4a)** — `review.ts`, `registry.ts`. Every enum program must pass the interpreter test. Adding `/bin/sh` is refused, even with a surface that claims `sh` runs no code. So are `bash`, `env`, `git`, `python3`, `find`, `xargs` and `node` under any directory. A property test shows any enum containing any listed interpreter is refused, and each one is named. An unlisted program with no surface, a surface for another program, or a code-bearing flag is refused. A clean one is accepted.
- **Adapter (§2.4, build plan Inc 3)** — `workload-adapter.ts`, `adapter.ts`. Each call runs in a fresh workload container through `docker compose run`, with `cwd` as one argv element and each `argv` element passed after the service name (D-034). Adapters only plan. One executor runs exactly the planned `execFile(program, argv[])` with stdin closed (D-033).
- **Registration conformance suite (§2.4, acceptance test 5)** — `conformance.ts`. It feeds a fresh canary (shell metacharacters, both quotes, backslash, space, tab, newline) into every text-carrying `data` field. Each canary must arrive as exactly one whole argv element, in no other string and not in the program, with list order intact. Results:
  - **Canary survives intact.** The conforming adapter passes. A container test sends canaries through the registered `shell.run` into the real workload: `cat /proc/self/cmdline` shows each one as a discrete, byte-identical argv element, and the program runs in a directory named by a canary.
  - **Non-conforming adapter blocked.** An adapter that builds `sh -c "cat " + argv` is refused at registration. The capability is then not registered and `invoke` refuses it before anything runs.
  - Also blocked: shell-quoting then joining, joining without a shell, `--workdir=` + cwd, a program path built from data, dropped, duplicated, reversed or split argv, and an adapter that throws on metacharacters.
- **Registration refuses incomplete bindings** — a missing, unlisted or duplicate adapter, no provider at all, or a second registration of the same id (D-032).
- **Calls are parsed before anything runs** — unknown or missing fields, a program outside the enum, argv as one string, a relative cwd, and NUL in a string are refused (D-032). On the host, a call's cwd and argv reach a real program as the same array.
- **D-025 Inc 3 directive: workload limits, each hit by a container test** (`test/containers/limits.test.ts`, D-030). 1 CPU, 512 MiB memory with no swap, 128 tasks.
  - Memory: 256 MiB succeeds; 1024 MiB is OOM-killed (exit 137).
  - Processes: 40 children start; 400 stop with `EAGAIN` before 128.
  - CPU: three busy threads use about 2.9 CPUs unlimited and at most 1.15 CPUs in the workload.
  - Docker starts the workload with exactly these values. The tests hold on cgroup v1 (this host) and v2 (CI).
- **`work-vol` ownership** (`test/containers/work-vol.test.ts`, D-031). A new volume is owned by the workload user (65532, mode 0755) whichever container mounts it first. The workload can write it; the runner can read but not write it.
- **Mutation-checked:** 27 deliberate breakages, each caught by a test. Suite side: parsed-string, discreteness, list-order, program-file and refused-canary checks turned off; canary without metacharacters; fixed canary. Registry side: review skipped; refused entry stored; missing adapter, no provider, or duplicate id allowed; call parsing skipped; NUL allowed; relative program, data-role program field, or duplicate surface allowed. Executor side: stdin left open; non-zero exit rejected. Adapter side: argv joined, `--workdir=`, no entrypoint override. Containers: no pids, memory or CPU limit; swap unbounded; runner image without `/work`.
- **Per-call promotion of code-bearing argv positions (§2.3 rule 2, O-2 ruling D-036; D-037, D-038).** `argvRoles` (`packages/contracts/src/promotion.ts`) reads each call's argv against the program's declared flag surface. The element where a declared code-bearing flag, subcommand or operand sits, and every element after it, become separate `instruction` values at the `operator` floor. Anything the surface does not declare (an unknown flag, a flag cluster like `-ec`, an attached value like `-cCODE`, an undeclared operand, no surface, or a listed interpreter whose surface claims no code) promotes every element. `checkInstructionFloors` (`packages/registry/src/instruction.ts`) judges each instruction value alone against its own floor and returns `park` / `integrity_floor` naming each value that falls short. `argv` stays a `data` list in the definition, so §2.2 rule 2 holds. The definition names its argv field (`argv_field`).
- **Acceptance test 4b, mechanism part** (`packages/registry/test/promotion.test.ts`). `sh` is forced into the shipped `shell.run` (the same entry registration review refuses in 4a), and calls use model-written argv:
  - `sh -c CODE` parks `integrity_floor`, naming `argv[0]` and `argv[1]` at the `operator` floor.
  - **Code flag moved later:** `sh -e -c CODE`, `sh -e -u -x -c CODE`, and a nine-element argv with `-c` at index 5 each park, with promotion starting exactly at `-c`; the flags before it stay `data`. A property test puts any number of non-code flags before `-c` and any operands after CODE: it always parks, and always from `-c` on.
  - `-ec CODE`, `-cCODE`, `-o errexit -c CODE`, and an undeclared flag after the code all promote every element and park.
  - `sh` forced in with no surface, or with a surface claiming no code, parks.
  - The floor is `operator`, not the capability's `attested`: CODE at `attested` parks, at `operator` proceeds. The `program` field keeps `attested`.
  - No whole-list `min()`: model-written flags before `-c` with operator-authored code proceed; one low promoted element is the only one named. A promoted element with no recorded provenance parks.
  - The shipped `cat` is unchanged: calls with declared flags and plain operands proceed with untrusted argv (property test), `--` lets a file name start with `-`, and an undeclared `cat` flag promotes every element.
  - The end-to-end form (a task run by the runner reaches for `sh -c` and the task parks) needs Increments 4, 5 and 7. Increment 4 calls `checkInstructionFloors` as §2.7 step 3; Increment 7 runs 4b against the real containers.
- **Mutation-checked (O-2 work):** 14 more deliberate breakages, each caught: uncovered flags or operands ignored; only the element after the flag promoted; a fixed index 0 (the static reading); scanning stopped at the first code flag; the listed-interpreter check off; `--` not ending options; no surface treated as no promotion; promoted floor set to the capability floor; missing provenance passing; a whole-list `min()` over argv; promoted values or scalar instruction fields skipped; the `argv_field` type check off.
- Decisions D-028 to D-039 recorded.

## Remaining in this increment
- Nothing to build. CI must be green on the D-039 commit (see Status). Then waiting for the operator's review of `packages/registry/definitions/shell.run.json` (D-035) and merge.

## make verify
GREEN as of 2026-10-28 in the cloud session and in CI on PR #5, with D-036 built: 409 unit tests (13 files), 38 container tests (5 files), lint self-test rejected the `exec()` probe. Summary line: `make verify: GREEN`.

## Open objections to the spec
- None. (O-1 was resolved as D-024; O-2 was resolved by the operator on 2026-10-28 as the per-call, flag-aware reading; see D-036.)

## Notes for the next session
- **Next step:** once PR #5 is merged, Increment 4 (enforcement boundary) is current. Do not start it before the merge. Increment 4 must call `checkInstructionFloors` as §2.7 step 3, with integrity computed per argument by provenance class (§2.6), and record per-element `argv[<index>]` provenance on every `capability_call` (D-022, D-038).
- The spec text of §2.3 rule 2 should state the D-036 ruling at v0.6 (operator's note). `spec/` is not edited by the build.
- Read D-025 at the start of Increments 5, 6 and 7. The Inc 2 and Inc 3 directives are done.
- `packages/registry/definitions/` is not copied into the runner image yet; nothing in the runner loads the registry. Increment 5 must copy it when the runner registers capabilities at start.
- The adapter calls the `docker` CLI (D-034). Today only the host-side tests call it. Increment 5 must decide how the runner, inside its container, reaches Docker, and record the decision.
- §2.5's runtime detection (an adapter "observed constructing a parsed string" forfeits registration and quarantines its capability) and the `adapter_quarantined` park are enforcement, Increment 4. Not built here.
- The spec defines no scale for `isolation_tier`. `shell.run` declares `1`, meaning the one workload container (D-035). Nothing in Slice 1 reads it. If a later increment needs tiers to mean something, raise it then.
- Items later increments must pick up (none is an objection yet):
  - **Increments 4 and 5:** §3.3 canonicalization resolves symlinks. A resolved path outside `/work` must be refused, so a symlink inside the work volume cannot point a call at anything else. `shell.run`'s `cwd` and any path in `argv` are where this bites.
  - **Increment 5:** §5.3 requires `max_invocations` for `write`, `external` and `irreversible` grants, and a whole-filesystem scope needs an Override (out of Slice 1). Increment 5 must decide whether `/work` counts as "whole-filesystem". If the spec text does not settle it, raise an objection then.
  - **Increments 5 and 6:** §18 and the build plan list `ttl_expired` among the "park on" reasons, but §6.4 and the Increment 6 test say TTL expiry moves the task to `failed`. Raise this as an objection when that increment starts, if the text is still unclear then.
  - **Increments 5 and 6:** a crash between writing a journal entry and replacing the head leaves that task's chain failing verification (fails closed, D-027). No recovery is built.
  - **Increment 7:** acceptance test 3 needs a discovery program (for example `ls`) in the enum and the workload image (D-029). Add it as one reviewable diff that registration review accepts. Under D-037, a discovered file name that starts with `-` is read as an undeclared flag and promotes every argv element, so test 3 should pass bound file names after `--`. The discovery program's surface must declare every flag test 3 uses.
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. The hook removes pid files whose PID is not a docker daemon. This cloud host runs cgroup v1 with no swap; CI (`ubuntu-latest`) runs cgroup v2. The container tests depend on neither. The CPU-limit test needs at least two host CPUs (D-030).
- `docker compose run` attaches stdin; anything that runs a program through it must close stdin, or a program reading stdin hangs (D-033).
- Increment 0 notes still apply: no `npm install` in Dockerfiles (D-001); the runner has `network_mode: none` until Increment 5 (D-013). The workload image now has a build stage that only copies files and runs exec-form `mkdir`; it downloads nothing but its pinned base images.
