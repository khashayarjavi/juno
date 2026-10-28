# DECISIONS

Decisions made during the build that are **not** in the Core Semantic Model. Each one has a reason. Add new entries at the bottom, numbered in sequence.

Format:

```
## D-NNN — <title>
- Date: YYYY-MM-DD
- Status: Accepted | Proposed | Superseded by D-NNN
- Applies to: <increment or "forward record">
- Decision: <one or two sentences>
- Reason: <why>
```

D-001 to D-007 were set during the October 2026 planning review, before the build started. The operator may revise any of them.

---

## D-001 — Docker builds do not reach the network
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: TypeScript is compiled on the host, and the built output plus production `node_modules` are copied into the images. No Dockerfile runs `npm install` or downloads anything except its base image.
- Reason: cloud sessions route traffic through a security proxy with an allowlist, so network calls inside `docker build` are fragile there. It also makes images reproducible and keeps the build consistent with the workload container's no-network invariant (§2.2.1).

## D-002 — `make verify` uses a scripted fake provider
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 5 onward
- Decision: the provider adapter is tested against a scripted fake that returns predetermined model outputs. All acceptance tests run against the fake. A real-provider smoke test may exist as `make smoke`, but it never runs in `make verify` or CI.
- Reason: tests 2 and 3 must prove the enforcement boundary regardless of what a model chooses to do, so the model's output must be controlled. It also keeps CI free, deterministic and keyless. JUNO cannot use the operator's Claude subscription (third-party harnesses are excluded since April 2026), and `api.anthropic.com` cannot receive a cloud-environment network secret, so a real key would need to sit in an environment variable.

## D-003 — Increment numbering
- Date: 2026-10-28
- Status: Accepted
- Applies to: all of Slice 1
- Decision: the build plan says "seven increments" but lists eight, numbered 0 to 7. Use the numbering as listed. Increment 7 is acceptance.
- Reason: removes an ambiguity before it reaches a session.

## D-004 — MCP protocol target (forward record)
- Date: 2026-10-28
- Status: Accepted
- Applies to: forward record — the first slice that adds MCP. Not Slice 1.
- Decision: target MCP specification revision 2026-07-28. Servers that only speak 2025-11-25 are not supported.
- Reason: 2026-07-28 removed protocol-level sessions and hardened authorization; it is not backward compatible.

## D-005 — STDIO MCP server commands are operator-authored only (forward record)
- Date: 2026-10-28
- Status: Accepted
- Applies to: forward record — the first slice that adds MCP. Not Slice 1.
- Decision: the command and arguments that launch a STDIO MCP server are registry entries written by the operator, with `instruction` role. They are never supplied, edited or selected by a model, a task, or retrieved content.
- Reason: the April 2026 MCP STDIO disclosure showed that launching a configured command is arbitrary code execution by design. Making the launch definition operator-authored puts it on the trusted side of the trust-relocation principle (few, static, operator-authored).

## D-006 — Delegation provenance test moves out of Slice 1 (forward record)
- Date: 2026-10-28
- Status: Accepted
- Applies to: forward record — the slice that introduces delegation between tasks.
- Decision: the October review proposed an "acceptance test 6": an injection read by a delegated sub-task cannot change the parent's control flow or widen its grants. Slice 1 has no delegation and no concurrent tasks, so the test is deferred to the slice that adds them, where it becomes mandatory.
- Reason: the test cannot be written without the feature. Recording it here keeps it from being lost.

## D-007 — CI runs `make verify` on every pull request
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: `.github/workflows/verify.yml` runs `make verify` on every pull request into `main`. The operator accepts an increment when the CI check is green and `STATE.md` says the increment is done.
- Reason: the build plan asks the operator to run `make verify` personally. The operator builds in cloud sessions and does not keep a local toolchain, so CI is the independent run. It also stops the coding agent from being the only witness to its own result.

## D-008 — Repository layout: the starter kit lives at the repo root
- Date: 2026-10-28
- Status: Accepted (operator, 2026-10-28)
- Applies to: Increment 0 onward
- Decision: the starter kit was first committed one level down (`juno-starter-kit/juno/`), with `juno-starter-kit.zip` beside it. Its contents now sit at the repository root, and the nested folder and the zip have been removed.
- Reason: GitHub runs workflows only from the root `.github/workflows/`, so with the kit nested, the D-007 CI check could never run. The SessionStart hook in `.claude/settings.json` also never fired. The zip duplicated tracked files.

## D-009 — Semantic model file renamed, content unchanged
- Date: 2026-10-28
- Status: Accepted (operator, 2026-10-28)
- Applies to: Increment 0 onward
- Decision: the spec arrived as `spec/core-semantic-model.md.md`. It was renamed to `spec/core-semantic-model.md` with `git mv`, and the content is byte-identical. The operator confirmed the file is the final v0.5.1. The `spec/README.md` final-version check looks for the wildcard-egress cross-reference in §8.3. That reference actually sits in §3.2 (it cites §8.3's "cannot observe the consequence" criterion), and §2.2.1 states it too. The operator accepted it there.
- Reason: CLAUDE.md §1 requires the file at exactly this path. A rename is not a content edit. CLAUDE.md rule 6 is about content.

## D-010 — Toolchain: TypeScript 6.0, ESLint 10 with typescript-eslint, Vitest 5
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: TypeScript 6.0.x, ESLint 10 (flat config) with typescript-eslint's `strict` preset, and Vitest 5 as the test runner (`npm run test:watch` for watch mode). Versions are pinned exactly in `package.json`. ES modules, `NodeNext` resolution, Node 22.
- Reason: TypeScript 7 is current, but typescript-eslint supports only versions below 6.1, and a lint rule that cannot parse the code is no control. Vitest runs TypeScript without a separate build step and has watch mode built in. Exact pins keep `make verify` reproducible between sessions weeks apart.

## D-011 — Runtime schema library: Zod 4
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: Zod 4 is the runtime schema library. Every boundary goes through `parseAtBoundary(boundary, schema, input)` in `packages/contracts`. It returns the typed value or throws `BoundaryError`, which callers treat as fail-closed.
- Reason: Zod gives the TypeScript type and the runtime check from one definition, so the two cannot drift. One helper means every boundary rejects input the same way (§0.2 D8).

## D-012 — The no-shell lint rule is a local plugin, and inline lint config is off
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: `tools/eslint-plugin-juno` defines `juno/no-shell`, at error level on every file. It allows only `execFile` to be imported from `child_process`, so `exec`, `execSync`, `spawn`, `fork`, `execFileSync`, whole-module imports, `require` and re-exports are all banned. It bans a `shell` option set to anything but the literal `false`. It also bans building an `execFile` program or argv element with a template literal or `+`. `noInlineConfig: true` makes every `eslint-disable` comment in the repo ineffective. `make lint` also feeds a deliberately non-conforming file to the real ESLint CLI and fails if ESLint does not reject it.
- Reason: CLAUDE.md rule 8 says use `execFile(program, argv)` only, and the rule must never be disabled inline. An allowlist fails closed, whereas a denylist misses the next launcher. Like the §2.4 conformance suite, the rule catches honest mistakes, not deliberate evasion (for example `process.binding`). That limit is stated in the rule's header (§0.5 corollary).

## D-013 — Container images and runtime settings for Slice 1
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 0 onward
- Decision: the runner image is `node:22-bookworm-slim` and the workload image is `gcr.io/distroless/nodejs22-debian12:nonroot`, both pinned by digest. The workload image therefore has no shell and runs as user 65532. Both services drop all Linux capabilities and set `no-new-privileges`. Both use `network_mode: none` in Increment 0. The runner gets its provider endpoints in Increment 5, and the workload never gets a network. The workload's default command is `node --version`, because it has nothing to run until capability invocations exist. `make verify` checks the images after building them (`test/containers/`): no shell file anywhere in the workload filesystem, non-root, zero capabilities, loopback only, no journal mount, and `docker compose up` exits 0 for both services.
- Reason: digest pins keep builds reproducible across sessions weeks apart (D-001). Distroless is the smallest image that removes the shell rather than relying on it going unused (build plan §1). The runner has no network in Increment 0 because nothing needs it yet (§0.2 D8, fail closed). `no-new-privileges` goes with "drops all capabilities": it stops a setuid binary from gaining privileges back. The checks inspect the running containers, because a Dockerfile that looks right proves nothing.

## D-014 — Specification errata applied (operator change)
- Date: 2026-10-28
- Status: Accepted
- Applies to: `spec/core-semantic-model.md`; matters from Increment 5 (admission checks)
- Decision: the spec first committed was the v0.5.1 draft from before the two August errata. Both were applied in place, with the text taken verbatim from the August design chat: §7.8's admission-consequence paragraph now cites §5.4 check 10 (the live-steer check), not check 11 (the autonomous zero-grants warning); §8.3 gains a note that §3.2's wildcard-egress prohibition is a sibling of the non-overridable parks; the v0.5.1 changelog records both. `spec/README.md` now names the exact marker for the final version. This is an operator change to `spec/`, not an agent edit.
- Reason: a cold session implementing admission in Increment 5 would otherwise follow a wrong cross-reference. No semantics changed.

## D-015 — `join` needs at least one input
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward
- Decision: `join` takes a non-empty list. The type requires one input, and the function throws `RangeError` if called with none. No "empty join" value exists.
- Reason: §1.2 defines join as max and min over inputs and says nothing about having none. Making up an identity element such as `(public, operator)` would hand material with no recorded source the highest integrity. Refusing the case invents nothing.

## D-016 — Encodings for ids, times, hashes and amounts
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward
- Decision: ids and refs are printable ASCII with no whitespace, 1 to 256 characters. Timestamps are ISO 8601 UTC with a `Z` suffix. Content addresses are `sha256:` plus 64 lowercase hex digits. Durations (`ttl`, `wall_clock_ms`, `duration_ms`) are whole milliseconds. Token, turn and invocation counts are non-negative integers. Currency is a non-negative finite number in the operator's billing currency. Every contract object rejects unknown keys.
- Reason: the model names these fields and leaves their encoding open. ISO timestamps and `sha256:` addresses can be read in the journal without tooling (§3.4.5, O9). Rejecting unknown keys means a misspelt field is an error and is never silently dropped (§0.2 D8). For example, `rol: "data"` fails instead of falling back to the `instruction` default.

## D-017 — Capability interface field types
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward
- Decision: an interface field's type is one of the scalars `string`, `path`, `integer`, `number`, `boolean` or `enum` (non-empty, unique values), or the complex types `list` and `map` of a scalar. Deeper nesting cannot be written. A missing `role` parses as `instruction`; an `instruction` field of type `list` or `map` fails to parse. Capability ids are dotted lowercase semantic ids with at least two segments, e.g. `fs.file.read`.
- Reason: §2.2 rule 2 forbids lists, maps and nested structures in `instruction` fields. Offering only scalars plus one level of list or map covers `shell.run` and the §2.2.1 example, and leaves nothing that can nest. The rule is checked at parse time, so a capability definition that breaks it never exists as a typed value.

## D-018 — How the interpreter predicate decides
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward (used by registration review in Increment 3)
- Decision: `interpreterVerdict(program, surface)` judges a program an interpreter if any of these holds: (1) its base name is on the §2.3 list, copied verbatim, whatever surface is declared; (2) no flag surface is declared for it; (3) the declared surface names a different program (exact match); (4) any declared argv position (flag, subcommand or operand) is marked `executes_code`. Otherwise it is not an interpreter. The base name is the last path segment with any trailing version number removed, so `/usr/bin/python3.12` is checked as `python`. This normalisation applies only to the list check.
- Reason: §2.3 makes the test primary and the list illustrative. A program with no declared surface cannot be shown to pass the test, so under §0.2 D8 it fails closed. List membership overrides a surface because the list states that its members are interpreters, so a surface claiming otherwise is wrong. Normalising names only ever adds programs to the interpreter side.

## D-019 — The exact `${<seq>.<path>}` grammar
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward
- Decision: a reference is the whole text `${seq.path}`. `seq` is a decimal integer with no leading zero. `path` is a first step (identifier or bracket) followed by `.identifier` or `[index]` or `["json string key"]` steps. Rejections are classed as `cross_task` (the seq position carries a task name: `task:12`, `12@task`, `task/12`, `task#12`, `task.12`), `ambiguous` (`*`, `..`, slices, unions, filters, negative indices, leading zeros), `unresolvable` (missing seq or path, empty segments or brackets, numbers above 2^53−1) or `malformed` (anything else, including whitespace, single quotes, and any text around the reference). The limit is 1024 characters. `formatReference` writes the canonical text, and parsing that text gives back the same reference.
- Reason: O9 asks for a JSONPath-style accessor chosen for auditability and requires ambiguous, unresolvable and cross-task forms to be rejected. The grammar keeps only the part of JSONPath that names exactly one value. A reference with text around it would be a template, and §2.6 says a template the model fills is `synthesized`, so such text is not a reference at all.

## D-020 — Grant selector shapes and attenuation dimensions
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward
- Decision: `capability_selector` is a non-empty, duplicate-free list of capability ids. `resource_scope` is a list of selectors: `path` (an absolute, normalised prefix that reaches itself and everything under it at a `/` boundary), `repo` and `record` (exact ids with no `*` or `?`), and `host` (an exact lowercase host name plus a mandatory port). No wildcard form exists. A grant must expire after it is issued. Attenuation compares seven authority dimensions: principal (must be equal), capability set, resource scope, max sensitivity, min integrity, expiry, and invocation cap (`null` means no cap). `issuance`, `issued_by`, `issued_at`, `id`, `attenuation_parent` and `revoked_at` are metadata or runtime state, not dimensions.
- Reason: §3.2 calls the capability selector "one capability or a bounded set", and an enumerated set is the reading that is bounded by construction. §2.2.1 and §3.2 require egress destinations to be enumerated. A grammar with no wildcard, and a host that always names its port, makes the prohibited unbounded scope impossible to write rather than something checked later. Prefix containment at a segment boundary follows the containment semantics of §3.3. Whether a child may be *equal* to its parent on a dimension is not decided here: that is objection O-1.

## D-021 — Task fields the model leaves as "structured"
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward (criterion contents are fixed in Increment 5)
- Decision: `model_policy` is `{ permitted_providers (non-empty), posture (text), conversation_state: "stateless" | "any" }`. `budget` is `{ tokens, currency, wall_clock_ms, turns }`, all required. `criterion` is a JSON object or `null`, with its contents left to admission. `ttl` is a positive number of milliseconds. `context_ownership` and `steer_capability` are `null` exactly while the task is a `draft`, because admission derives them. `runtime_substate` is `null` outside `running`. A missing `requires_live_steer` is filled in from `attendance` as §3.1 specifies.
- Reason: §3.1 names these fields and their parts without fixing a shape. A value derived at admission cannot exist before admission, and every task past `draft` must have it. §3.3 makes `blocked` a sub-state of `running` only.

## D-022 — Trajectory entry, closure and artifact details
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward
- Decision: `argument_provenance` is a list of `{ argument, class, integrity }`. It is required on `capability_call` entries and forbidden on every other kind. `binding_candidates` is a list of two or more distinct prior `seq` numbers, allowed only on `binding_resolution`. `provider` is `null` for entries no provider served (e.g. a park written by the runner). `hash_prev` is `null` only on a task's first entry (Increment 2 enforces the chain). On a closure, `criterion_ref` and `verification_method` may be `null` for tasks admitted without them. `verified` needs both, `criterion_integrity = operator`, and a `pass` result. `closureSchemaFor(executingActors)` adds the rule that `verifier_identity` is none of the executing actors, because the closure record does not carry the executing actor itself. Artifact `inputs` are references to artifacts or trajectory entries, and an artifact cannot supersede itself.
- Reason: §3.4.2 says provenance appears "on `capability_call`" and candidates "on `binding_resolution`". §3.4.4 and §5.1 state the `verified` conditions. Building the verifier rule into the schema means Increment 5 cannot write a self-verified closure even by mistake.

## D-023 — Property-based tests use fast-check
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 1 onward
- Decision: `fast-check` 4.10.2, pinned exactly, is a dev dependency. It supplies the property-based tests the build plan requires for the join, the reference grammar and attenuation. Because the lattice has only 16 elements, commutativity and associativity are also checked on every pair and triple.
- Reason: it is the standard property-based testing library for TypeScript and runs inside Vitest. It is test-only and never reaches the images.

## D-024 — Grant attenuation: a child may equal its parent (O-1 resolved)
- Date: 2026-10-28
- Status: Accepted (operator ruling on objection O-1, 2026-10-28)
- Applies to: Increment 1 onward
- Decision: the operator chose reading (a) of §3.2's "a strict subset of its parent on every dimension". A derived grant is a valid attenuation when it is no wider than its parent on every dimension; equality on a dimension is permitted, so an identical copy is valid. A child's `max_invocations` must not exceed the parent's: a `null` parent cap is unbounded, so any child cap is allowed under it, and a `null` child cap under a bounded parent is a widening. Invocations of a derived grant will be charged against the parent chain, mirroring §3.1's budget attenuation ("spend is attributed to the child and charged to the parent chain"). Enforcing that charge is deferred with delegation (D-006), because Slice 1 has no delegation and nothing consumes a derived grant. `isValidAttenuation` in `packages/contracts/src/attenuation.ts` implements the accept rule. This settles the point D-020 left open.
- Reason: reading (c) makes many grants impossible to attenuate (a single-capability grant, a grant already at `(public, operator)`, any grant with a fixed principal). Reading (b) adds nothing to safety, because an identical copy grants no authority the parent lacks. Charging the parent chain stops a child grant from multiplying the parent's invocation cap by being copied.

## D-025 — Operator directives for later increments (not spec changes)
- Date: 2026-10-28
- Status: Accepted (operator, 2026-10-28)
- Applies to: each item applies only in the increment it names. None of them is in force in Increment 1.
- Decision:
  - **Increment 2:** the hash chain covers each payload's digest, never its bytes. Deleting a blob leaves the chain verifiable.
  - **Increment 3:** the workload container gets fixed CPU, memory and process-count limits, proven by container tests that hit each limit.
  - **Increment 5:** one runner per journal volume. A second runner refuses to start.
  - **Increments 5 and 6:** `ttl` counts wall time, including host sleep and time spent parked. The `wall_clock` budget counts elapsed running time only.
  - **Increment 7:** every acceptance criterion names protected paths, and verification fails if the task wrote under them.
- Reason: operator directives that settle choices the model leaves to the build. They are recorded now so the session that reaches each increment applies them and cannot miss them. They do not change `spec/`.

## D-026 — Path selectors name only the capability namespace; the journal lies outside it
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 2 onward
- Decision: the capability namespace for paths is `WORK_NAMESPACE = /work`, the path where the workload container mounts `work-vol`. A `path` selector's prefix must be `/work` or under it at a `/` boundary, so `/`, `/journal`, `/etc` and `/workspace` fail to parse as grant scope. The journal refuses to open, or to be read, at any root that contains or lies inside `/work`. The runner refuses to start when `JUNO_JOURNAL_DIR` overlaps `/work` or `JUNO_WORK_DIR`. `docker-compose.yml` mounts `journal-vol` at `/journal` in the runner only. The runner image creates `/journal` owned by the runner user with mode 0700, so a new volume takes that ownership. One unit-test fixture path, `/data`, became `/work/data` because the old path can no longer be written; the property it serves (attenuation is reflexive, transitive, and accepts exactly the non-widening children) is unchanged.
- Reason: §3.2 requires that no selector can name journal storage, "structurally impossible rather than procedurally forbidden", and §3.4.1 says journal storage lies outside the capability namespace, so any attempt to name it is "rejected at grant creation". Bounding every path selector to one fixed namespace, and keeping the journal out of that namespace at every place it can be configured, makes a journal-naming selector impossible to write. A property test checks that no accepted journal root and no accepted path selector overlap. `repo`, `host` and `record` selectors name identifiers, not storage locations. `/work` is a container mount point, not an assumption about the operator's machine (§15, D4).

## D-027 — Journal storage format, chain encoding and head record
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 2 onward
- Decision: each task has its own chain. `seq` starts at 0 and rises by 1. An entry is stored as one line of canonical JSON (keys sorted, no whitespace, `JSON.stringify` scalars). Its hash is `sha256:` of that line, and the next entry's `hash_prev` is that hash. The entry holds `payload_ref`, the payload's digest, never the payload bytes (D-025). A head record (`task_id`, `seq`, `hash` of the last entry) is kept beside the entries and replaced atomically after each append. Verification needs every line canonical, a valid TrajectoryEntry for this task, `seq` equal to its position, `hash_prev` equal to the previous line's hash (`null` first), and the chain to end exactly at the head. Layout: `<root>/tasks/<sha256 of task id>/entries.jsonl` and `head.json`, and `<root>/blobs/sha256/<2 hex>/<62 hex>`. The writer assigns `seq`, `task_id`, `payload_ref`, `hash_prev` and `timestamp` (from its clock), checks the whole entry against the contract, then writes the blob, then the entry, then the head, each flushed to disk. It verifies a task's stored chain before its first append, and again if the files differ from what it last wrote, and never appends to a chain that fails. The read interface returns entries only when the whole chain verifies. A blob read is `present` (bytes match their address), `missing` or `corrupt`, and corrupt bytes are never returned.
- Reason: §3.4.2 requires an append-only hash chain, and the build plan requires mutation, truncation and reordering to be detected. A chain alone cannot show that entries were cut off its end, so the head record is what makes tail truncation detectable. Canonical form means one entry has exactly one stored form, so any byte change is detected. The task id becomes a digest in the path because ids may contain `/` or `..` (D-016). The writer assigns the chain fields so a caller cannot forge them.
- Accepted residuals (§0.5 corollary): the chain cannot detect deletion of a whole task directory, or a coordinated rewrite of a task's entries and head, by someone who can write `journal-vol`. The protection there is placement: the workload cannot reach `journal-vol` (container test), and only the runner mounts it. A crash between writing an entry and replacing the head leaves the task's chain failing verification (`head_mismatch`); that fails closed, and no recovery is built. A reader in another process could see an entry before the head moves; in Slice 1 only the runner reads, in the same process.

## D-028 — Increment 3 branch name
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3
- Decision: Increment 3 is built on `claude/inc-3-registry-ucto18`, not `inc-3-registry`. The cloud session harness created that branch for this increment and allows pushes only to it. The pull request still goes into `main`.
- Reason: CLAUDE.md §4 names branches `inc-<N>-<short-name>`, and the operator's session prompt says to continue on an existing branch for the increment. The harness branch is that branch, and a push to any other name would be refused. The name does not change what the increment is or how it is accepted.

## D-029 — The `shell.run` program enum names `/usr/bin/cat` only, by absolute path
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3 onward
- Decision: the program enum in `packages/registry/definitions/shell.run.json` has one member, `/usr/bin/cat`. Programs are named by absolute, normalised path, so no search path decides what runs. The workload image copies `/usr/bin/cat` from the same digest-pinned Debian 12 image the runner uses; it needs only libc, which the distroless Debian 12 image already has. Its declared flag surface lists every option of GNU coreutils 9.1 `cat` and its operand, none of which runs code. Adding a program later means adding it to the image, the enum and the surfaces in one reviewable diff, and registration review must accept it.
- Reason: the distroless workload image contains no programs except `node`, which is an interpreter (§2.3). `cat` is enough to prove the adapter and the conformance suite end to end, because `cat /proc/self/cmdline` prints the argv it received. `ls` would need two more shared libraries copied under architecture-specific paths. Discovery is needed first by acceptance test 3 (Increment 7), and it is added there, not scaffolded now (CLAUDE.md rule 9).

## D-030 — Workload resource limits: 1 CPU, 512 MiB memory without swap, 128 tasks
- Date: 2026-10-28
- Status: Accepted (values chosen under operator directive D-025)
- Applies to: Increment 3 onward
- Decision: `docker-compose.yml` gives the workload `cpus: 1.0`, `mem_limit: 512m`, `memswap_limit: 512m` (swap equal to memory, so no swap) and `pids_limit: 128`. `test/containers/limits.test.ts` hits each limit. Memory: 256 MiB succeeds and 1024 MiB is killed (exit 137, `OOMKilled`). Processes: 40 children start and 400 stop with `EAGAIN` short of 128. CPU: three busy threads use more than 1.5 CPUs without a limit and at most 1.15 CPUs in the workload. It also checks that Docker starts the workload with exactly these values. The probes read only `pids.max`, at its cgroup v2 or v1 path, so the tests pass on both (this cloud host runs v1 and CI runs v2). The CPU proof needs a host with at least two CPUs, and the test fails rather than passing vacuously on fewer.
- Reason: D-025 asks for fixed limits proven by tests that hit them, and leaves the values open. These are generous for the programs Slice 1 runs, while small enough that a runaway task cannot take the host. A pids limit also counts threads, so it bounds fork bombs and thread bombs alike. The operator may change the values; the tests read them from one place.

## D-031 — `work-vol` belongs to the workload user
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3 onward
- Decision: the `/work` mount point is owned by `65532:65532` with mode `0755` in both images (the workload image copies it in, the runner image creates it with exec-form `RUN`), so a new `work-vol` takes that owner and mode whichever container mounts it first. The workload can write the work volume; the runner can read it but not write it. A container test checks both mount orders and the runner's write refusal.
- Reason: STATE.md assigned `work-vol` ownership to Increment 3. Before this, a new volume first mounted by the runner was owned by root, and the non-root workload could not write its own worktree. The runner does not write the worktree in Slice 1 so far. If Increment 5 needs it to, that increment decides how (for example a shared group), and records it.

## D-032 — Registry entry format and registration rules
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3 onward
- Decision: a capability definition is a JSON file under `packages/registry/definitions/`, versioned by git. It holds `capability` (the §2.1 Capability contract), `program_field` (the interface field naming the program: it must exist, be `instruction` and be an `enum` whose values are absolute paths) and `program_surfaces` (one declared flag surface per program, D-018). Unknown keys are refused. `CapabilityRegistry.register(definition, adapters)` refuses, and stores nothing, if any of these holds: the definition does not parse; the id is already registered; any enum program fails the interpreter test (`interpreter_in_enum`, with the reason); the capability lists no provider; a listed provider has no adapter; an adapter is supplied that is not listed, or twice; any adapter fails the conformance suite. All refusals found are reported together. `invoke(id, call)` refuses an unregistered id, parses the call against the interface (every field required, no unknown fields, no NUL in any string), and runs the first listed provider's adapter. Grants and the other enforcement checks are not in `invoke`; Increment 4 wraps it.
- Reason: §2.5 makes definitions few, operator-authored, versioned, reviewable artifacts, and JSON keeps policy as data (§15). §2.3 rule 3 reviews enum membership at registration, so registration is where the interpreter test runs, and a refusal says which program and why. §2.4 makes conformance a registration condition, so a capability whose adapter fails cannot exist in the registry and no task can invoke it. A NUL cannot pass through `execve`, so a string containing one could not arrive intact.

## D-033 — What the conformance suite feeds and inspects
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3 onward
- Decision: an adapter only plans: it turns a parsed call into one outbound invocation (`file`, `args`). `executeOutbound` runs exactly that invocation with `execFile`, so the suite inspects what is executed. The suite builds a call with a fresh canary in every text-carrying `data` field (two for a list, one under `/work/` for a path) and neutral valid values elsewhere. Each canary is `juno-canary-<random tag>-<n>` followed by the shell metacharacters `; | & $ ( ) < > * ? [ ] { } ! # ~`, a backtick, both quote characters, a backslash, a space, a tab, a newline, and `%s${IFS}=,:` (`CANARY_PAYLOAD` in `conformance.ts`). It never starts with `-`. The adapter passes only if each canary is exactly one whole element of `args`, byte for byte; no other element and not the program contains the canary's tag; and a list's canaries are consecutive and in order. An adapter that throws on a canary fails. `executeOutbound` closes the program's stdin at once (no capability has a stdin channel), reports a non-zero exit or a signal as a result, and rejects only when the program cannot start or its output overflows. A container test then sends canaries through the registered `shell.run` into the real workload, where `cat /proc/self/cmdline` shows the argv it received.
- Reason: §2.4 asks the suite to show that the canary arrives "structurally intact" and that "no parsed string in the outbound request contains it". Equality of whole elements is structural intactness. A tag inside any longer string is interpolation, whether or not the adapter quoted or escaped it (§2.4: interpolating "forfeits its registration"). A fresh tag each run stops an adapter passing by recognising a fixed canary. Accepted residual (§0.5 corollary, as §2.4 itself says): an adapter built to evade the suite, for example one that passes the canary as a discrete element to a program that parses it again, is not caught. Human review of the few adapters is the primary control.

## D-034 — The `shell.run` adapter runs each call in a fresh workload container
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3 onward
- Decision: the adapter `workload.execfile` plans `docker compose -f <file> -p <project> run --rm --no-deps -T --workdir <cwd> --entrypoint <program> <service> <argv...>`. Each call gets a new workload container with every setting `docker-compose.yml` declares (no network, user 65532, no capabilities, `no-new-privileges`, the D-030 limits, only `work-vol`). `cwd` is one argv element. Each `argv` element follows the service name, where compose passes it to the program unparsed. Overriding the entrypoint means the image's default command is never appended, so an empty `argv` arrives empty (container test).
- Reason: the build plan's adapter is "`execFile` across the container boundary, argv as an array". Docker passes the command array to `execve` without a shell, which the container test proves for the canary. A fresh container per call means no state carries from one call to the next except through `work-vol`. Forward record: the adapter calls the `docker` CLI, which today runs on the host (tests). When Increment 5 makes the runner call it from inside its container, that increment must decide how the runner reaches Docker, and record it.

## D-035 — The `shell.run` definition's values, and who authors them
- Date: 2026-10-28
- Status: Accepted (pending operator review of the definition file in the Increment 3 pull request)
- Applies to: Increment 3 onward
- Decision: `shell.run` declares `side_effect: read` (its only program reads), `min_argument_integrity: attested` (§2.2's illustration of `program`), `max_input_sensitivity: internal`, `output_class: (input, untrusted)` (§2.1's usual rule), `isolation_tier: 1`, and a cost model of no currency, 2000 ms expected latency (one container start) and no cost of failure. The spec defines no scale for isolation tiers; Slice 1 has exactly one isolation tier, the workload container, and `1` means that tier. Nothing in Slice 1 reads `isolation_tier`. The coding agent drafted `shell.run.json`; it becomes operator-authored when the operator reviews and merges it.
- Reason: §2.5 requires capability definitions to be operator-authored, never model-generated. The agent can only propose a file; the operator's merge, after review, is the authorship act, and later changes are reviewable diffs. Each value is the narrowest that lets the Increment 3 tests run, and the pull request lists them for review. `min_argument_integrity` for interpreter positions is part of objection O-2 and is not decided here.

## D-036 — Interpreter argv positions are promoted per call against the declared flag surface (O-2 resolved)
- Date: 2026-10-28
- Status: Accepted (operator ruling on objection O-2, 2026-10-28)
- Applies to: Increment 3 onward (the promotion and floor check are built in Increment 3; Increment 4 calls them from the enforcement boundary)
- Decision: the operator chose the flag-aware, per-call reading. An interpreter's declared flag surface (D-018) names which flags introduce code. On every call, each `argv` element in a code-bearing position under that surface is judged as its own scalar `instruction` value, with its own provenance, against the `operator` floor (§2.3 rule 2, "restoring the operator floor"), not against the capability's `min_argument_integrity`. If a call's `argv` contains a flag the declared surface does not cover, every `argv` element is treated as `instruction` (fail-closed). This answers the three questions of O-2: (1) it does not breach §2.2 rule 2, because each promoted element is judged alone and no `min()` is taken over the whole list, so `argv` stays a `data` list in the definition; (2) positions are found per call by reading the `argv` against the declared surface; (3) a promoted element's floor is `operator`, while the `program` field keeps the capability's `min_argument_integrity`. The operator called this reading (a); in O-2's own labels it is the per-call reading listed there as (b), with the fail-closed rule added. The spec text should state this explicitly at v0.6. `spec/` is not edited by the build.
- Reason: operator ruling. Per-call reading catches a code flag moved to any index (`sh -e -c CODE`), which a fixed index cannot. The fail-closed rule closes the hole O-2 named for this reading: where the boundary's reading of the `argv` could differ from the program's own option parser, because the call uses something the surface does not declare, nothing is left as `data`.

## D-037 — How a call's argv is read against a declared flag surface
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3 onward
- Decision: `argvRoles(program, surface, argv)` in `packages/contracts/src/promotion.ts` reads the argv left to right. A declared `--` ends option parsing; every later element is an operand. Any other token that starts with `-` (except `-` alone) is a flag and must match a declared flag exactly, so short-flag clusters (`-ec`), attached values (`-cCODE`, `--flag=value`) and abbreviations are not matches. A non-flag token is a declared subcommand if one has that name, otherwise an operand. The first element whose declared position executes code is promoted, and so is every element after it. Every element is promoted (fail-closed) if, anywhere in the argv, a flag is not declared or an operand appears where no operand is declared; if the program has no surface or the surface names another program; or if the program is on the §2.3 list and its surface declares no code-bearing position. The rule applies to every program in an enum, not only to interpreters, so a `cat` call with an undeclared flag is also fully promoted.
- Reason: D-036 says the surface names which flags introduce code, but not how many elements after a flag carry it. In every form §2.3 lists (`-c CODE`, `-e CODE`, `-exec CMD ;`, `--use-compress-program PROG`), the code is at or after the flag that introduces it. The boundary cannot know a flag's value count or where the code ends without reimplementing each program's own parser, which is the mismatch O-2 warned about, so it promotes to the end of argv. Elements before the code-bearing one keep `data`, because the surface classified each of them as a non-code position. Exact matching means anything the surface does not spell out falls into the fail-closed rule. A listed interpreter whose surface declares no code is known to be wrong (D-018). Applying the rule to all programs costs a non-interpreter nothing it needs: a call that uses only declared flags is unchanged, and a file name that starts with `-` can follow `--`. Accepted residual (§0.5 corollary): the surface is operator-authored and trusted. A surface that marks a code-bearing position as non-code, or a program that executes code in a way no argv position shows (stdin, files already in `/work`, environment), is not caught by this rule.

## D-038 — Where promotion lives, and what Increment 4 calls
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3 onward
- Decision: a registry entry gains a required `argv_field`, which must name a `data` list of strings (`argv` in `shell.run.json`). The D-017 field-type language is not extended: `argv` stays a `data` list in the definition, and promotion is derived per call. `instructionValues(entry, call)` in `packages/registry/src/instruction.ts` parses the call, then lists every scalar `instruction` field with the capability's `min_argument_integrity` and every promoted argv element as `argv[<index>]` (the D-022 naming) with the `operator` floor. `checkInstructionFloors(entry, call, provenance)` takes the recorded `argument_provenance` and returns `proceed`, or `park` with reason `integrity_floor` and one violation per value below its own floor. A value with no recorded provenance is a violation. Neither function computes integrity from a provenance class (§2.6), resolves references, or looks at grants; Increment 4 does those and calls `checkInstructionFloors` as §2.7 step 3. The registry's `invoke` does not call it.
- Reason: promotion needs to know which field is the program's argv; naming it in the definition keeps that an operator-authored, reviewable choice (§2.5) instead of a guess from field names. Keeping `argv` a `data` list keeps §2.2 rule 2 intact, as D-036 requires. Acceptance test 4b ("force the enum change through") needs the mechanism to work on an entry that registration review refused, so it takes a parsed entry, not a registered one. Splitting the floor check from integrity computation keeps Increment 4's work (provenance, binding, grants) out of Increment 3.

## D-039 — The CPU test's no-limit control takes up to three samples
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 3 onward (amends how D-030's CPU proof is measured; the values are unchanged)
- Decision: the control in `test/containers/limits.test.ts` ("uses more than 1.5 CPUs with three busy threads when no CPU limit is set") runs the 3-second probe up to three times and passes when any sample is above 1.5 CPUs. Every sample must still report at least two host CPUs. The limited test is unchanged: one sample, between 0.8 and 1.15 CPUs.
- Reason: on PR #5, CI run 40737367665 (commit 35d71d6, which changed only STATE.md) measured 1.28 CPUs in the single unlimited sample, while the same code passed on commit 6a4a3c8. A shared CI host can be busy for one short window. The control exists to show that the host can serve more than one CPU of demand, so that the limited result of at most 1.15 is the limit's doing. One sample above 1.5 shows that just as well as three, so the threshold stays 1.5 and the proof keeps its strength. Noise on a shared host only lowers usage. It can make the control fail, never pass falsely, so retrying the control cannot hide a missing limit.
