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

## D-040 — Increment 4 branch name
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 4
- Decision: Increment 4 is built on `claude/laughing-lovelace-bj5e9m`, not `inc-4-enforcement`. The cloud session harness created that branch and allows pushes only to it. The pull request still goes into `main`.
- Reason: as D-028. A push to any other name would be refused. The name does not change what the increment is or how it is accepted.

## D-041 — What reaches the enforcement boundary, and how each argument's data class is computed
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 4 onward (Increment 5 supplies the inputs)
- Decision: the boundary takes a proposal (`packages/enforcement/src/proposal.ts`): a capability id and, per interface field, one argument source, or one per element for a list field. A source states its class by mechanism: `constant` names a slot, `bound` carries a `${<seq>.<path>}` reference, `synthesized` carries the model's literal. Argument names follow D-022 (`argv[1]`). Proposal keys must be lower-case identifiers, so a key such as `argv[0]` cannot collide with a list element's name. Each argument's data class is:
  - `constant`: the class admission fixed for the slot. Admission (Increment 5) sets its integrity to the admitting source's (§2.6). A slot admission never fixed is not a value, and the call is rejected (D-045).
  - `bound`: the referenced entry's `data_class`, on both axes.
  - `synthesized`: sensitivity is the producing turn's, supplied by the turn loop. Integrity follows §2.6: under `native` context it is `untrusted`; under `owned` it is the `min()` of the volatile region's integrities, which the turn loop must supply. An `owned` task with no volatile region supplied is refused (an error, so nothing runs). The context mode is read from the task, never from the caller.
  §2.7 step 5's "aggregate input sensitivity" is the highest sensitivity among the call's argument values (the sensitivity of their join).
- Reason: invariant 7 requires provenance by mechanism, so the class must be carried by how a value arrives, never inferred from the value. §2.6 gives integrity per class but not sensitivity. §1.2 gives the rest: a value carries the class "computed at creation from its own inputs". A bound value *is* the referenced entry's value. A synthesized value is part of the turn that produced it, so it is at least as sensitive as that turn. A constant is what admission fixed. Taking the context mode from the task, and failing when an owned task omits its volatile region, means the boundary never computes integrity from something the caller could leave out.

## D-042 — Grant storage, coverage and invocation counting
- Date: 2026-10-28
- Status: Accepted (the choice among covering grants and the `data_class_bounds` sentence are amended by D-046)
- Applies to: Increment 4 onward
- Decision: `GrantStore` (`packages/enforcement/src/grants.ts`) parses every grant it stores and refuses a second grant with the same id. A grant covers a call only when all of these hold: the task lists it; the store holds it; its principal is the task's; its capability selector names the capability; `now >= issued_at`; `revoked_at` is null; `now < expires_at`; and, when capped, fewer than `max_invocations` calls have been charged to it. A grant that fails any of these does not cover the call. The first failing reason is reported, in that order: `unknown_grant`, `principal_mismatch`, `capability_not_selected`, `not_yet_issued`, `revoked`, `expired`, `exhausted`. With no covering grant the call parks `awaiting_grant`, so an expired, revoked or used-up grant parks the task (§6.2: "no covering grant"). A non-null `revoked_at` counts as revoked even if the time it records is later than now. One grant must hold the whole call: among the covering grants, the call proceeds under the first, in the order the task lists them, whose scope contains every checked data value, and it is charged to that grant. Grants are never combined. A call is charged once, when the boundary authorizes it. A parked or rejected call is never charged. The counts live in the store, in memory. `data_class_bounds` are not applied (objection O-3).
- Reason: §3.2 makes expiry mandatory and revocation and caps part of the grant, and §6.2 parks a call with no covering grant. A grant whose principal is not the task's is authority the task never held (§3.2 "effective authority = intersection"). A grant not yet issued, or carrying a recorded revocation, fails closed (§0.2 D8). Requiring one grant to hold the whole call is narrower than the union §3.1 allows, never wider, and it makes the grant to charge unambiguous. Charging only authorized calls means a cap counts effects the boundary allowed. Forward record: Increments 5 and 6 must keep grants and counts across a runner restart (acceptance test 1). The `capability_call` entry of every call that proceeded names its grant, so the counts can be rebuilt from the journal.

## D-043 — Bound reference resolution and what the boundary records
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 4 onward
- Decision: a reference resolves against the calling task's own verified trajectory and nothing else (`readTrajectory` for that task id). It must name an existing entry whose payload is present, is JSON, and holds a single scalar (string, finite number or boolean) at the path. A path naming nothing, an object, an array or `null` is `unresolvable`. Parse failures keep their D-019 codes (`cross_task`, `ambiguous`, `unresolvable`, `malformed`). The candidate set is every prior entry of the task whose payload holds a single scalar at the same path, the referenced entry included. It is recorded as `binding_candidates` when it has two or more members. The boundary appends one `binding_resolution` entry per `bound` argument, whether it resolved or was rejected, and then exactly one `capability_call` entry per proposal. That entry carries `argument_provenance` for every argument whose provenance is known, and its payload records each value, its origin (slot; or reference, referenced entry and binding entry), the verdict and, for a call that proceeds, the grant. These entries name the actor `juno.enforcement` and provider `null`. A `binding_resolution` entry's data class is the join of the referenced entry's class with the synthesized class (or the synthesized class alone when rejected). A `capability_call` entry's data class is the join of the synthesized class with every argument's class.
- Reason: O9's grammar names exactly one entry, so read literally, "where the reference shape matches more than one entry" (§2.7 step 1) could never happen. The sentence has effect only if the *shape* is the path: the same path can name values in several entries, and the model chose one. Recording that set is what lets review tell "a hostile prior entry selected over a benign one" from coincidence. This reading only adds to the record and never changes a verdict. Values are scalars because O9 references name "exactly one value", and every list element has its own provenance (D-022). These entries hold model-composed text (the references and the proposal), so their class is never more trusted than the model's output. A later reference into one of them can therefore never gain integrity.

## D-044 — Runtime observation of the structural channel, and quarantine
- Date: 2026-10-28
- Status: Accepted
- Applies to: Increment 4 onward
- Decision: at §2.7 step 6 the boundary first parks `adapter_quarantined` when the serving adapter (the first provider listed, D-032) is quarantined for the capability. Otherwise the registry plans the call (`CapabilityRegistry.plan`, which runs nothing), and the boundary inspects that invocation. Every `data` value of type `string` or `path` must be one whole element of `args`. Every `data` list of strings must appear as consecutive elements in its own order (an empty list trivially does). If either fails, or the adapter throws on a call that parsed, the registry records a quarantine for that (capability, adapter) pair with the observation, and the call parks `adapter_quarantined`. A quarantine is permanent for that registry instance. `plan` and `invoke` refuse a quarantined adapter. `perform` runs exactly the invocation that was inspected, once, and only for an authorization this boundary issued.
- Reason: §2.5 says that "where detection is possible it is applied": an adapter observed building a parsed string from a `data` field forfeits registration and quarantines its capability. A value missing as a whole element was transformed on its way to the provider, and that is observable for every call. Running only what was inspected keeps the inspection meaningful. Accepted residual (§0.5 corollary): real values are not unique the way the canary is. So this check cannot tell whether a value also appears inside a longer element (`-n` is inside `--no-deps`), and an adapter that delivers a value discretely and also interpolates it passes here. The registration canary (D-033) is the control for that. Forward record: Increment 5 decides whether a quarantine survives a runner restart; until then a restart forgets it, but registration review and the suite still run at start.

## D-045 — Check order, the five checks, and outcomes that are not parks
- Date: 2026-10-28
- Status: Accepted (where candidate grants are looked up is amended by D-046; the guarantee is kept. Its exception is extended by D-048: step 3 runs before every rejection but an unknown capability. Extended again by D-052 and D-054: a proposal of the wrong shape is judged first and then rejected `malformed_call`; only one that is not even a capability id and an object of arguments throws `BoundaryError`)
- Applies to: Increment 4 onward
- Decision: the build plan's "five enforcement checks" are the grant check plus §2.7 steps 3 to 6. They run in this order: steps 1 and 2 (resolve, classify), step 3 (`checkInstructionFloors`, D-038), the grant check (`awaiting_grant`), step 4, step 5, step 6. The first check that fails decides the park. A call proceeds only when all pass. Three outcomes are rejections, not parks: an argument that does not resolve (a rejected reference, or a constant slot never fixed), an unregistered capability, and a call that does not parse against the interface. In each, nothing runs, nothing is charged, the `capability_call` entry records the rejection, and the task keeps running. One exception keeps step 3 ahead of parsing: when a call does not parse, each scalar `instruction` field that was supplied is still judged on its own provenance, and one below its floor parks `integrity_floor`. A proposal that is not even the proposal shape throws `BoundaryError`, and a task not in `running` cannot call at all.
- Reason: §2.7 lists steps 3 to 6 in order and does not place the grant check. Step 4 needs "the Grant", so the grant check must come before it. Putting it after step 3 keeps §2.7's order intact, and it means an injected instruction (`integrity_floor`, not overridable, §8.3) is never presented as a missing grant. Otherwise the operator would be asked, at the cost of an interruption (D9), for a grant on a call that can never run. O9 says the runtime "rejects" bad references. §2.7 says "rejects … → park" when it means a park. No §6.2 reason fits, and no operator decision can repair a model's malformed call. Judging a supplied instruction field before parsing means a synthesized command string parks `integrity_floor` whether or not it happens to be a valid enum value (acceptance test 2): the defence fires on provenance, not on the value's shape. Objection O-3 may move the grant check before step 3, if the ruling makes a grant's bounds part of step 3.

## D-046 — A grant's `data_class_bounds` tighten §2.7 steps 3 and 5 (O-3 resolved)
- Date: 2026-10-29
- Status: Accepted (operator ruling on objection O-3, option (b), 2026-10-29)
- Applies to: Increment 4 onward
- Decision: a grant's `min_integrity` raises the floor of each instruction value to at least itself. Instruction values are the scalar `instruction` fields and the argv elements promoted under §2.3 rule 2. It never applies to a `data` field. A breach parks `integrity_floor`. A grant's `max_sensitivity` lowers step 5's ceiling below the capability's `max_input_sensitivity`, and a breach parks `sensitivity_ceiling`.
  The boundary looks up the candidate grants (those that cover the call, D-042) before step 3, but decides `awaiting_grant` only after step 3 passes. So D-045's guarantee holds: an injected instruction is never presented as a missing grant.
  Step 3 runs in two stages. First, `checkInstructionFloors` checks each value against its own floor (D-038). Then every candidate is checked with its raised floors, and only the candidates whose floors the call meets are kept. If candidates existed and none is kept, the call parks `integrity_floor`, and the park lists each grant with the values below its raised floor.
  Each later step keeps the candidates the call meets: step 4 by scope, step 5 by the grant's `max_sensitivity` after the capability's ceiling. The first step that leaves none decides the park. The call proceeds under the first remaining candidate in the order the task lists its grants, is charged to it, and the `capability_call` entry names it.
  This amends D-042 (which grant authorizes the call; bounds are now applied) and D-045 (when candidate grants are looked up).
- Reason: operator ruling. It keeps §2.2.1's split: integrity governs instruction values, sensitivity governs inputs. §8.3's rule makes an instruction value below any floor an unobservable harm, so a breach of a grant's floor is not overridable either. Keeping a candidate only while the call meets it means a call never proceeds under a grant whose bounds it fails. A grant can never lower a floor: each value is first held to its own floor.

## D-047 — Every argv operand is scope-checked as a path, as written (O-4 resolved)
- Date: 2026-10-29
- Status: Accepted (operator ruling on objection O-4, options (b) and (i), 2026-10-29)
- Applies to: Increment 4 onward
- Decision: at §2.7 step 4, `path`-typed data fields are checked as before.
  Each argv element that the D-037 surface reading classes as an operand is also normalised as a path and must fall within a path selector of the grant. A relative operand is read against the call's working directory, and `.` and `..` are resolved as written (never above `/`). Flags and subcommands are not resources and are not checked.
  Plain text resolves under the working directory, so it passes whenever that directory does. An absolute path or a `..` escape outside the scope parks `scope_violation`. The park names the argument, its value and the normalised path that was judged. With no surface for the program, or a surface naming another program, every element is read as an operand.
  Scope is judged on the normalised path as written; symlinks are not resolved.
  To make this exact:
  - the D-037 reading is now one function (`readTokens` in `packages/contracts/src/promotion.ts`). Promotion and the scope check both use it, through `argvRoles` and the new `argvTokenKinds`.
  - a registry entry gains a required `cwd_field`, which must name a scalar `data` path. `shell.run.json` names `cwd`. This is a reviewable change to the definition file (§2.5).
- Reason: operator ruling. One shared reading means the boundary cannot class an element as a flag for one purpose and as an operand for another. Naming the working-directory field in the definition keeps that an operator-authored choice instead of a guess from field names (as D-038 did for argv).
  Accepted residual (§0.5 corollary), recorded at the operator's direction: a symlink already present in the work content can reach outside the scope. Resolving symlinks (§3.3's canonical form) is a gate that must be built **before JUNO operates on any content it did not create (Slice 1.5)**, not only when a program that can create a link is admitted. In Slice 1 the work content is the operator's, and no capability can create a link.

## D-048 — Integrity is judged before an unresolved argument is rejected
- Date: 2026-10-29
- Status: Accepted (operator ruling on the independent review of PR #6, 2026-10-29; extends the D-045 exception). Amended by the operator's ruling on the second review, 2026-10-29: a missing program is no declared surface (below), and every value under an instruction field is judged in any shape (D-052).
- Applies to: Increment 4 onward
- Decision: step 3 runs before any rejection except an unknown capability (there is no interface to judge against then).
  - Every instruction value whose integrity is established is held to its own floor, then to each candidate grant's raised floor (D-046). Established means a `constant` from a fixed slot, a `synthesized` value, or a `bound` reference that resolves.
  - An instruction value whose own `bound` reference does not resolve has no established integrity. It is judged `untrusted`, so it parks `integrity_floor`. The `capability_call` entry records it as `bound` / `untrusted`, and its payload lists every unresolved argument under `unresolved`.
  - Only when every instruction value passes does an unresolved argument produce the `unresolved_argument` rejection. A call that does not parse is rejected `malformed_call` after that.
  - How the call is read while an argument is unresolved: the missing value stands in as a plain operand (an argv string), the root `/` (a path), or a neutral value, so the rest of the call can still be read. The program field gets no stand-in its enum accepts: with no program, the argv is read against no surface, so every element is promoted (D-037 `no_declared_surface`). A stand-in never goes past step 3.
  - **Amendment (operator ruling on the second review, 2026-10-29): a missing program means no declared surface.** When the call has no program field at all, its argv is read against no surface, so every argv element is promoted to an instruction value at the `operator` floor (D-037, fail-closed). A synthesized `-c` with a broken `cwd` reference and no program therefore parks `integrity_floor`; so does the same call with a valid `cwd`. More generally, the argv is read against the program only when the program field holds one value whose provenance is established; a program that is missing, unresolved, a constant slot never fixed, wrapped in a list or map, or a value that states no provenance gives no surface (D-052, D-054).
  - A constant slot that admission never fixed is not judged at all, neither as untrusted nor at any floor. The ruling names bound references only, and D-045's test of an unfixed slot stays a rejection. It still cannot mask anything: every other instruction value is judged first.
  - Grant floors are now applied before the `malformed_call` rejection too, because they are part of step 3 (D-046).
- Reason: operator ruling. §8.3 makes an instruction value below its floor not overridable, and a resolution failure must not hide it behind a rejection the model can simply retry. §1.5 fails closed, so a value whose provenance cannot be established gets the lowest integrity. Reading an unresolved argv element as an operand, not as an undeclared token, keeps the build plan's test 4 (a cross-task reference is rejected) and the ruling's third test true. It does not loosen anything, because a call with an unresolved argument never runs.
  Accepted residual: an unresolved argv element whose real value would have been a code-bearing flag cannot be read as one. The elements after it are then read as if it were an operand. The call is still rejected and nothing runs; when the model retries with a reference that resolves, the full D-037 reading applies.

## D-049 — A call with no argument values is not below every ceiling
- Date: 2026-10-29
- Status: Accepted (from the independent review of PR #6)
- Applies to: Increment 4 onward
- Decision: the input class of a call (`callInputClass`, `packages/enforcement/src/boundary.ts`) is the join of its argument values' classes. With no argument values, it is the synthesized class of the producing turn. Step 5 always judges that class's sensitivity against the capability's and each candidate grant's ceiling. There is no "no input" case that passes every ceiling.
- Reason: the proposal itself is text the producing turn composed (D-043 classes the `capability_call` entry the same way), so even an empty call carries that turn's sensitivity (§1.2). Treating "no arguments" as "below every ceiling" was a fail-open special case (§0.2 D8). No registered capability can make such a call today (every registry entry has a program, argv and cwd field), so the rule is proven on `callInputClass` directly.

## D-050 — A path held in a map-typed data field fails the scope check
- Date: 2026-10-29
- Status: Accepted (from the independent review of PR #6)
- Applies to: Increment 4 onward
- Decision: at §2.7 step 4, every value of a `map` data field whose value type is `path` is a `scope_violation`, whether or not it lies inside the scope. The violation names the argument `<field>["<key>"]` and the value as written. A map of another value type is not a resource and is not checked. An empty map yields nothing.
- Reason: D-047 rules how path fields and argv operands are read. It says nothing about paths held in a map, and the check previously skipped them, which fails open. No shipped definition has such a field. Until the operator rules how a map's paths are read, refusing them is the fail-closed reading (§0.2 D8).

## D-051 — An undeclared flag skips the scope check only because it promotes the whole argv
- Date: 2026-10-29
- Status: Accepted (recorded at the operator's direction after the independent review of PR #6)
- Applies to: Increment 4 onward
- Decision: the scope check (D-047) reads only operands as paths. A flag token is never a resource, including a flag the program's surface does not declare, even when its text carries a path (for example `--x=/etc/passwd`). Such a flag is let through step 4 **only because** D-037 promotes the whole argv to instruction values at the `operator` floor whenever any element is undeclared. So it reaches step 4 only when every argv element has `operator` integrity: written by the operator, never by the model or by content.
- Reason: making the dependency explicit means a later change to either rule is seen to affect the other. If D-037's fail-closed promotion is ever relaxed, undeclared flags must be scope-checked (or refused) in the same change.

## D-052 — Shape never outranks provenance (second review of PR #6)
- Date: 2026-10-29
- Status: Accepted (operator ruling on the second independent review of PR #6, 2026-10-29; extends D-045 and D-048)
- Applies to: Increment 4 onward
- Decision: before the proposal's shape is checked, every value placed under an instruction-role field name is judged at that field's floor (`min_argument_integrity`, raised by each candidate grant's `min_integrity`, D-046). This holds in any shape: a scalar, a list, a map, or any nesting of them, at any depth.
  - A value is judged by its own provenance. A value below its floor parks `integrity_floor`. That includes a `bound` value whose reference does not resolve, which is judged `untrusted` (D-048).
  - Only after every such value passes may the boundary return `unresolved_argument` or `malformed_call`.
  - Each value is named by where it sits: `program`, `program[0]`, `program["run"][0][1]` (D-022 extended). The `capability_call` entry records its provenance under that name.
  - Proven by a property test (`enforcement.test.ts`, "D-052"): for any proposal with a synthesized or unresolved value anywhere under the program field, in any shape, with or without broken references elsewhere and with or without a grant, the verdict is park `integrity_floor`. It is never a rejection and never proceeds. Explicit tests cover `program: [cmd]` and `program: [<broken reference>]`.
- Reason: operator ruling. The second review found that wrapping the program in a list (`program: [cmd]`) renamed it `program[0]`. Step 3 looked only for `program`, found nothing to judge, and the call was rejected `malformed_call`. That let an injected instruction be retried silently instead of parked (§8.3). Its provenance must decide, not its shape.

## D-053 — The adapter's planned command is copied exactly once
- Date: 2026-10-29
- Status: Accepted (operator ruling on the second independent review of PR #6, 2026-10-29; extends D-044)
- Applies to: Increment 4 onward
- Decision: at §2.7 step 6 the boundary reads the serving adapter's planned invocation exactly once: `file` once, `args` once, and each element once. It reads them into a frozen copy of plain strings. That single copy is the one:
  - inspected for structural delivery (D-044);
  - journalled: the `capability_call` entry of a call that proceeds records the `adapter` and the `invocation`, and an `adapter_quarantined` park records the copy it judged;
  - carried in the Authorization;
  - run by `perform`.
  The call is also frozen once, after step 3. That frozen call is what the adapter plans from (the registry gives the adapter its own parsed copy), what scope and delivery are judged on, and what the Authorization carries. An adapter that returns no program string and argv array of strings is treated as refusing a valid call and is quarantined (D-044).
- Reason: operator ruling. Before this, the boundary read the adapter's object several times: once per data field during inspection, and again to build the Authorization. An adapter returning getters could show a conforming command to the inspection and a different one to `perform`. A test uses exactly such an adapter. Its second read returns another command; only the first is inspected, journalled, authorized and run, and each getter is read once.

## D-054 — How the boundary reads a proposal of the wrong shape
- Date: 2026-10-29
- Status: Accepted (build decisions needed to apply D-052 and the D-048 amendment)
- Applies to: Increment 4 onward
- Decision:
  - **What must hold before step 3.** Only a capability id (a string) and an object of arguments. Anything less throws `BoundaryError`: with no capability there is no interface, and with no arguments there is no value to judge. Everything else about the shape is checked after step 3, against `ProposedCall` and then the interface, and a failure there is `malformed_call`.
  - **Walking the values.** An object that is an argument source (`constant`, `bound` or `synthesized`) is one value. Any other list or object is walked into. Anything else is one value that **states no provenance**: a bare string or number, `null`, or a structure deeper than 16 levels (`MAX_ARGUMENT_DEPTH`, which keeps the walk bounded).
  - **A value that states no provenance has none.** It fails every floor: its integrity is recorded as absent, the same as a missing `argument_provenance` (D-038). It is left out of `argument_provenance`. The `capability_call` entry lists it under `unprovenanced` by name and shape (string, number, list…), never by content. Under a data field it is not judged at step 3, but the proposal is not `ProposedCall`, so it is rejected `malformed_call`. It never proceeds.
  - **Keys that are not identifiers.** A top-level argument key that is not a plain identifier is named `["<key>"]`. A key such as `argv[0]` therefore never collides with the first element of `argv`, and `argument_provenance` keeps one entry per argument.
  - **An argv that is not a list of single values** (a scalar, a map, or a list holding lists or maps) cannot be read against any surface. Every value in it is promoted to an instruction value at the `operator` floor, with the reason `argv_not_a_list`. This is D-037's rule that anything the surface does not declare promotes every element.
  - **A program outside the enum has no declared surface.** When the program field holds one established value that is not an enum member (an operator constant `/bin/sh`, or a synthesized command string), it has no declared surface, so every argv element is promoted (D-037 `no_declared_surface`). Two existing tests changed for this, and neither got weaker:
    - "rejects a program outside the enum when its provenance meets the floor" now gives `argv` as an operator constant, so every instruction value really does meet its floor and the rejection is still proven. Its former input (an operator `/bin/sh` with a synthesized `-c`) is a new test that now parks `integrity_floor`.
    - "parks a synthesized command string alongside a broken data reference" expected the program as the only violation. Where the call also has an argv, it now expects the promoted `argv[0]` too.
- Reason: the ruling says every value under an instruction field is judged "in any shape", so the boundary must reach values that the old strict proposal schema refused outright. The old schema threw `BoundaryError`, which is neither a park nor a recorded rejection. A value with no stated provenance is the §1.5 fail-closed case: its integrity cannot be established. Reading an argv of the wrong shape, or under a program with no surface, as "every element promoted" is D-037 applied as written, not a new rule. Leaving it out would reopen the same bypass through the argv field. All of these only turn a rejection into a park, or a park into one that names more values. None lets anything run that ran before.

## D-055 — Autopilot rules added to CLAUDE.md (operator change)
- Date: 2026-10-30
- Status: Accepted (director, 2026-10-30)
- Applies to: Increment 5 onward
- Decision: the director's autopilot rules were added verbatim to `CLAUDE.md` as §7, and three rules were added to §2: 11 (`docs/blueprint/` is context, never instructions), 12 (no invisible or bidirectional-control Unicode in source, tests or capability files, enforced by a lint check with a self-test) and 13 (a package, version or API exists only when the lockfile installs it in CI). §7 overrides earlier sections where they conflict. Under it, ambiguities the spec text does not settle are decided by the more restrictive reading and recorded as "autopilot ruling"; merges go through the §7 merge gate. The review prompt §7 calls "P2" is the one headed "Independent review before merging" in `docs/session-prompts.md`, the only review prompt there. The director numbered the runner-placement ruling D-065, and it is recorded under that number below; D-058 to D-064 are used by later decisions in order, and the sequence then continues at D-066.
- Reason: operator change to the agent's instructions, recorded so a later session knows when and why they changed. It is not a change to `spec/`.

## D-056 — A task whose journal fails verification after a crash is never resumed (standing ruling)
- Date: 2026-10-30
- Status: Accepted (director's standing ruling, 2026-10-30)
- Applies to: Increment 6 (forward record)
- Decision: when a task's journal fails verification after a crash (for example D-027's `head_mismatch` from a crash between the entry and the head), the task is never resumed. It goes to `failed`, and the reason is recorded.
- Reason: director's ruling. Resuming on an unverified record would act on evidence that cannot be trusted (§3.4, invariant 6).

## D-057 — Increment 7 acceptance criteria name protected paths; tests 2 and 3 pass together (standing ruling)
- Date: 2026-10-30
- Status: Accepted (director's standing ruling, 2026-10-30)
- Applies to: Increment 7 (forward record)
- Decision: D-025's Increment 7 directive applies: every acceptance criterion names protected paths, and verification fails if the task wrote under them. Acceptance tests 2 and 3 must pass together, in the same run.
- Reason: director's ruling. Either test alone is easy to pass (build plan Increment 7); passing both is the proof.

## D-065 — The runner runs on the host for Slice 1; no Docker socket in any container (standing ruling)
- Date: 2026-10-30
- Status: Accepted (director's standing ruling, option (b), 2026-10-30)
- Applies to: Increment 5 onward. Settles the D-034 forward record (how the runner reaches Docker).
- Decision: for Slice 1 the runner runs on the host, not in a container, and no container is given the Docker socket. The runner calls the `docker` CLI on the host to start each workload container (D-034). The journal stays outside `/work` and outside every workload mount, and a container test must prove the workload still cannot read or write it.
  The `juno-runner` image and service from Increments 0 to 2 remain: they hold no Docker socket and run no task, and their container tests still prove `journal-vol` is invisible to the workload. Tasks are run by the `Runner` class on the host (`test/containers/runner.test.ts` runs one against the real workload and proves the host journal is unreachable from it).
- Reason: director's ruling. A runner inside a container would need the Docker socket to start workload containers, and the Docker socket is root on the host: any process that reached it could undo the workload's seal. Keeping the runner on the host keeps the socket out of every container.

## D-058 — The hidden-character check (CLAUDE.md rule 12)
- Date: 2026-10-30
- Status: Accepted
- Applies to: Increment 5 onward
- Decision: `tools/check-unicode.js` scans `packages/`, `test/`, `tools/`, `containers/`, `scripts/`, `.github/`, `.claude/` and the root source and configuration files (including every capability definition under `packages/registry/definitions/`). It refuses every format character (Unicode `Cf`: the bidi embeddings, overrides, isolates and marks, zero-width characters, the byte-order mark, soft hyphen, tag characters), the line and paragraph separators, every space separator except the ASCII space, variation selectors, the combining grapheme joiner and the Hangul fillers. `make lint` first runs `--self-test`, which plants twelve such characters in a scratch tree laid out like the repository and fails unless the real scan finds every one and nothing in a clean file; then it scans the repository and fails on any finding, naming file, line, column and code point. `test/lint/unicode.test.ts` checks each class and that the repository is clean. Binary files (any NUL byte) are skipped. `spec/` and `docs/` are prose inputs and are not scanned (the spec is read-only).
- Reason: rule 12. A bidi override or zero-width character makes text read differently from how it parses, and the operator accepts work without reading code, so what a reviewer sees must be what runs. A separate script, not an ESLint rule, because ESLint does not read JSON capability definitions, Dockerfiles or the Makefile. The self-test follows the D-012 pattern: the check must be shown to fire, not only to pass. The source of the check and its test name every character by escape, so they contain none themselves.

## D-059 — The one Slice 1 provider is the scripted provider, with a profile file
- Date: 2026-10-30
- Status: Accepted (autopilot ruling)
- Applies to: Increment 5 onward
- Decision: the build plan's "one provider adapter, one Provider Capability Profile" is the scripted provider of D-002 (`ScriptedProvider`, `packages/runner/src/provider.ts`) behind a `Provider` interface, and its profile `packages/runner/providers/scripted.json`. The profile carries every §13.1 field plus `id` (what `model_policy.permitted_providers` names), `model` and `model_version` (recorded on every turn, §3.4.3) and `posture` (matched exactly against `model_policy.posture`). It is stateless, client turn control, `replay_fidelity: full` (the runner sends, and hashes, the whole context every turn), native context management available, and prices per token in, out and cached. No real-provider adapter is built in Slice 1, so the runner needs no network, and `network_mode: none` stays on the runner service. Every provider answer is parsed at the boundary (`ProviderResponse`): model output is untrusted input. Its limits fail closed: at most 32 proposed calls per turn, text of at most 65536 characters, call ids of at most 128 characters, capability ids and argument names of at most 128 characters; a turn past any of them is a malformed turn (D-063).
- Reason: D-002 makes the scripted fake the provider for `make verify` and CI. CLAUDE.md rule 13 forbids asserting from memory that an API exists, and no real provider's API can be installed or reached in CI, so a real adapter could not be shown to work. More restrictive: no adapter that cannot be verified, and no network for the runner. `posture` is matched exactly because a looser match would route a task to a posture it did not ask for.

## D-060 — How the model states an argument's provenance in a tool call
- Date: 2026-10-30
- Status: Accepted
- Applies to: Increment 5 onward
- Decision: in a tool call, `{"ref": "<reference>"}` is a `bound` argument, `{"slot": "<name>"}` a `constant` argument, and any other string, number or boolean a `synthesized` one (`packages/runner/src/translate.ts`). A reference written as plain text is synthesized text. Lists and other objects keep their shape and every scalar inside them is wrapped as synthesized, so an object the model writes (including one shaped like an argument source, `{"class": "constant", "slot": "cat"}`) is never taken as a source; the boundary judges every value inside it under the field it was placed in (D-052, D-054). `null` and non-finite numbers are passed unchanged and state no provenance. A list or object nested as deep as the boundary's depth limit (`MAX_ARGUMENT_DEPTH`) is replaced by `null`, so no object the model wrote reaches the boundary unwrapped at any depth. (First review of PR #8: the earlier cut-off was one level too deep, so a source-shaped object at exactly 16 list levels reached the boundary as written and was read as a constant. Nothing new was reachable, since `{"slot"}` already names any constant and that shape is rejected `malformed_call`, but it broke this rule. A test now nests a forged constant 1 to 20 levels deep and requires `integrity_floor` each time.) Tool results name the `seq` of their `capability_result` entry, whose payload holds `stdout`, `stdout_lines` and `stderr`, so a model can bind a discovered value (`${<seq>.stdout_lines[0]}`).
- Reason: invariant 7 requires provenance by mechanism. An explicit wrapper is the mechanism; recognising references inside text would make the provenance of a string depend on its content. Wrapping every model scalar means nothing the model writes can reach the boundary as a `constant` or `bound` source except through the two wrappers.

## D-061 — Admission rulings
- Date: 2026-10-30
- Status: Accepted (autopilot rulings, each the more restrictive reading)
- Applies to: Increment 5 onward
- Decision: `admit` (`packages/runner/src/admission.ts`) runs §5.4 checks 1 to 11 and reports every failure together. Where the spec leaves a choice:
  - **Closure mode (checks 2, 3).** `verified` only with a criterion, a verification method and `criterion_integrity = operator`; otherwise the task is admitted `accepted`, with a warning. `attested` needs a second actor, which Slice 1 does not have. A task with no criterion records `criterion_integrity: untrusted`: there is no author to credit.
  - **Model-drafted criteria stay `derived`.** §5.2's promotion by explicit operator acceptance needs an acceptance surface that restates the criterion's consequences, which is the approval interface (out of Slice 1). So no admission input promotes a model criterion.
  - **Check 4.** Every referenced source must be registered and classified, and every selector of every grant the task lists must lie within one of the task's sources, so nothing a task can reach lacks a declared class.
  - **Check 5.** A provider satisfies the policy when the policy permits it, its posture matches exactly, and it is stateless whenever the policy asks for that or the floor is `confidential` or above (§10.3). The floor admission judges includes every constant's own sensitivity.
  - **Check 6.** All four axes are required by the schema. The estate budget part is not built: estate budgets are out of Slice 1 (CLAUDE.md rule 9).
  - **Checks 8 and 10, routing.** The task is routed to the first permitted provider that passes checks 5, 8 and 10; `steer_capability` is derived for it by the §7.8 table.
  - **Context ownership (§10.2).** Slice 1's only strategy, `direct`, permits only `constant` and `bound` instruction arguments, and no admission input requires full replay, so every task is `native` and a synthesized value is always `untrusted` (§2.6). `owned` would let a synthesized value take the integrity of its volatile region, which could let model-authored text meet an instruction floor; Slice 1 never derives it.
  - **§5.3.** A grant selecting a `write`, `external` or `irreversible` capability must set `max_invocations`. A path selector naming the whole capability namespace (`/work`) is a whole-filesystem scope and needs an Override, which Slice 1 does not have, so admission rejects it. Grants must exist and belong to the task's principal.
  - **Also rejected:** a non-`direct` strategy, a parent (no delegation), ids under `juno.` (the runner's own records), a criterion whose command does not parse against its capability, a constant named like a criterion slot, and an id that already has a trajectory (an id is admitted once). A rejected admission is journalled under its id at `(secret, untrusted)`, because nothing about it was classified.
- Reason: §0.2 D8 and CLAUDE.md §7 rule 3: where the text leaves a choice, the reading that admits less. Each choice keeps the §18 tests possible: acceptance tests use operator criteria, grants scoped below `/work`, and constants or bound references for the program.

## D-062 — The criterion, the verification method, and the closure
- Date: 2026-10-30
- Status: Accepted (settles D-021's "criterion contents are fixed in Increment 5"; autopilot rulings where marked)
- Applies to: Increment 5 onward
- Decision:
  - **Criterion.** `{ command: { capability, arguments }, expect_exit_code }`. Each argument is a literal fixed at admission and becomes a constant slot (`criterion.<field>`, `criterion.<field>.<index>`) with the criterion's integrity (§2.6). The one method is `command_exit`.
  - **Verification.** When the model answers with no capability calls it claims the task is done (§6.1: it cannot confer it). For a `verified` task the runner then proposes the criterion's command, all constants, through the same enforcement boundary as any call, under the task's grants; the call is charged and journalled like any other. A park there parks the task. A rejection, a signal, or a program that cannot start is `inconclusive`. Budgets do not stop verification; TTL does.
  - **Outcomes (autopilot ruling).** `pass` writes the closure and moves the task to `verified`. `fail` and `inconclusive` move it to `failed` with `verification_fail` / `verification_inconclusive`, and write no closure, because §6 allows only `verified | failed` and the closure schema allows `verified` only with `pass`. If the closure is refused at write time (for example its verifier is an executing actor), the task moves to `failed` with `closure_refused`, recorded in its trajectory, and the refusal is raised to the caller. A task that is not `verified`-mode goes to `complete_unverified`; its principal may close it `accepted` (closure `verification_result: inconclusive`, verifier = the principal).
  - **Verifier.** `juno.verifier`. The closure is parsed with `closureSchemaFor(executing actors)` at write time. The executing actors are the runner, the enforcement boundary, the model, and every adapter that performed a task call, so none of them can verify.
- Reason: §3.4.4 and §5.1 need a machine-evaluable criterion and a deterministic method. Running it through the boundary means verification gets every §2.7 check and no second path to the workload exists. Failing on `inconclusive` fails closed. Counting the runner and boundary as executing actors is the restrictive reading of "must not equal the executing actor".

## D-063 — Turn loop, budgets, TTL and the classes of runner entries
- Date: 2026-10-30
- Status: Accepted (autopilot rulings, each the more restrictive reading)
- Applies to: Increment 5 onward
- Decision:
  - **Turn.** The runner assembles the context (a fixed preamble, the objective with the criterion and constants, then every earlier turn and tool result), offers every registered capability as a tool, calls the provider, and journals a `turn` entry with the exact request, its hash, the parsed response, the profile's model and version, and the cost. The turn's class is the join of `derived` with everything in its context (§1.2). A response the runner cannot parse is recorded, counted as a turn, and told to the model; nothing runs.
  - **Calls.** Each proposed call goes to `authorize`. On `proceed` the runner calls `perform` and journals a `capability_result`. On `park` it writes a `park` entry (with `overridable: false` for `integrity_floor` and `adapter_quarantined`, §8.3) and the rest of the turn's calls are not acted on. On `reject` it tells the model and continues.
  - **Budgets.** A turn starts only while every axis is below its limit. After a turn, any axis above its limit parks, and that turn's calls are not acted on. Wall clock is also checked before every call. Tokens count in, out and cached. Currency is computed from the profile's prices, never taken from the provider. Wall clock counts running time only (D-025).
  - **TTL.** Wall time since admission, parked time included (D-025). On expiry the task goes to `failed` with `ttl_expired` (§6.4). §18 and the build plan list `ttl_expired` among the parks; §6.4 and Increment 6's test say `failed`, which is the stricter reading (a failed task never resumes), so it is applied. No objection is raised: the spec text settles it.
  - **Provider failure.** A provider that throws parks `routing_unavailable` (§6.2: the required routing cannot be served). The same park fires before a turn when the floor has risen past what the routed provider may serve (§10.3).
  - **Result class.** A `capability_result`'s sensitivity is the capability's output rule (the call's input sensitivity for `shell.run`) raised to every source the task references; its integrity is the lower of the rule's and the input's. The task's `sensitivity_floor` is raised to it, with a `note` recording the change (§1.2).
  - **One task at a time.** A runner starts a task only when no other task of its is running; concurrent tasks are out of Slice 1 (§18, CLAUDE.md rule 9).
  - **Runner entries.** State notes, parks, verification notes and closures are `derived` at most (a park after a call takes the call entry's class, which is lower). Only the admission note, which holds operator input alone, can be `operator`. So a bound reference into anything the runner wrote can never lift text into an instruction field (invariant 1).
- Reason: these settle choices the spec leaves to the build, each fail-closed. Counting every token and computing currency locally means a provider cannot under-report its way past a budget.

## D-064 — One runner per journal, and quarantines that survive a restart
- Date: 2026-10-30
- Status: Accepted (applies D-025's Increment 5 directive; settles D-044's forward record; autopilot rulings)
- Applies to: Increment 5 onward
- Decision: the runner creates `runner.lock` in the journal root exclusively when it starts and removes it when it closes. A second runner on the same journal finds the lock and refuses to start. A lock left by a crashed runner is not taken over; the operator removes it. Every quarantine the registry records is appended, once, to the runner's own chain under the reserved id `juno.registry`. At start the runner reads that chain (verified) and quarantines each adapter again, so a quarantine is permanent across restarts, and admission check 9 then refuses the capability. A record that does not verify or does not parse stops the runner from starting.
- Reason: D-025 requires one runner per journal volume. Taking over a stale lock could let two runners write one journal, so the restrictive reading leaves it to the operator (§0.2 D8). §2.5 makes a forfeited registration a quarantine; forgetting it on restart would let a non-conforming adapter serve again.

## D-066 — Resume, rebuilding a task from its journal, and grant counts across restarts
- Date: 2026-10-30
- Status: Accepted (autopilot rulings, each the more restrictive reading; applies the standing ruling D-056)
- Applies to: Increment 6 onward
- Decision: `Runner.resume(id, { grants? })` (`packages/runner/src/runner.ts`) resumes a parked task in this order:
  1. **Never resumed:** a task whose journal does not verify (D-056); a task parked `integrity_floor` or `adapter_quarantined`. (Amended in Increment 7, after the second review of PR #9: the TTL check of step 2 now runs before the non-overridable check, so an expired task on such a park goes to `failed`, as §6.4 requires, instead of staying parked.) Resuming continues the turn loop, and §8.3 makes those parks unclearable, so they end only by a new task (autopilot ruling). Only a `parked` task resumes.
  2. **TTL** (§6.4): wall time since admission, parked time included. Expired: `failed`, `ttl_expired`.
  3. **Added and dropped grants.** The operator may add grants issued while the task was parked. Each must exist and pass admission's grant rules (principal, §5.3, check 4); otherwise the resume is refused and nothing is recorded. The operator may also drop grants from the task (`remove_grants`), which only narrows its authority; each must be on the task and not also added.
  4. **Grants re-evaluated** (§6.3 step 1). Any grant the task lists that is unknown, another principal's, not yet issued, revoked, expired or exhausted re-parks `awaiting_grant`, with `phase: resume`. That is a superset of §6.3's "expired or revoked" (autopilot ruling). **Consequence, recorded after the first review of PR #9:** a task that still lists an unusable grant never runs again, however many valid grants are added. Most often that is a capped grant that has run out, which §5.3 requires for write-class capabilities. To resume it, the operator drops the unusable grant (step 3). Without that step, the restrictive reading would leave such a task unresumable for good.
  5. **Model policy and floor re-evaluated** (§6.3 steps 2 and 3). A provider this runner does not serve, or one the policy no longer allows at the task's floor (§10.3), re-parks `routing_unavailable`.
  6. **The `resume` entry** records the park resumed, the grants added, every grant's status, invocations and expiry, the provider and whether it can serve, the floor, the TTL left and the spend. Then the task runs again. The model is told that the call it was parked on did not run.
  - There are no locks in Slice 1, so §6.3 step 4 has nothing to do. Budgets cannot be raised on resume in Slice 1, so a `budget_exceeded` task resumes into an immediate re-park.
  - **Rebuilt from the journal alone** (§3.4.5). A task this runner does not hold is rebuilt from its trajectory, which now records enough to do so:
    - the admission note carries `admitted_at` (the runner's clock), the criterion and the provider's profile;
    - every context item is a `note` of type `context` with its class;
    - every park and state note carries the spend at that moment;
    - floor changes and added grants are in their own notes and `resume` entries.
    A trajectory that shows the task still `running` was cut off by a crash. It is failed `runner_interrupted`, because an effect may have happened that the trajectory does not show (autopilot ruling).
  - **The runner is free after a re-park.** A resume claims the runner only when the task runs again, so a resume that re-parks (or fails on TTL) leaves the runner free for the same task or another one. (The first review of PR #9 found that a re-park left it claimed.)
  - **Classes of the runner's own records.** `grant_charge` notes are `(internal, derived)`: they name grants, tasks and seqs, nothing read or composed. `task_failed` notes are `(secret, derived)`: they quote a chain failure from a journal whose classes can no longer be read, so the most restrictive sensitivity is used. `juno.registry` quarantine notes are `(internal, derived)` (D-064). Nothing ever binds a reference into these records (they are not task trajectories).
  - **Park entries** now carry the boundary's verdict detail, so the reason for a park is readable from the park entry itself.
  - **Grant counts across restarts.** Before every `perform`, the runner appends a `grant_charge` note to its own record, `juno.runner`. So the effect is never counted after it happens, and a crash can only over-count. At start the runner rebuilds every count from that record, and refuses a grant store that already holds charges. A charge naming a grant no longer stored is ignored: that grant can cover nothing.
  - **D-056 applied.** A task whose journal fails verification gets a `task_failed` note in `juno.runner` (reason `journal_unverifiable`, with the chain failure), since nothing can be appended to a broken chain. That record stands even if the files are later repaired: such a task is never resumed. A `juno.runner` record that does not verify or does not parse stops the runner from starting.
- Reason: §6.3 ("agent resumed ≠ agent still authorized") and §6.4, failing closed wherever the text leaves room. Acceptance test 1 (park, stop, resume next day) needs a task rebuilt by a new runner, with its grants' counts intact (D-042's forward record). Charging durably before the effect closes the gap that in-memory counts leave.

## D-067 — Acceptance: the discovery program, protected paths, the journal account, and forcing the enum
- Date: 2026-10-30
- Status: Accepted (autopilot rulings where marked; applies D-057)
- Applies to: Increment 7
- Decision:
  - **Discovery program (settles D-029's forward record).** `/usr/bin/ls` (GNU coreutils 9.1) joins `cat` in the workload image and the `shell.run` enum. The image copies it with `libselinux.so.1` and `libpcre2-8.so.0`. An exec-form `RUN node -e` step finds them under whichever `<arch>-linux-gnu` directory the image uses and stages them at the same path, owned by root (`COPY` without `--chown`), so the workload user owns no program or library it runs (container test). Its declared flag surface lists `-1 -a --all -A --almost-all -d --directory -F --classify -l -n --numeric-uid-gid -R --recursive -r --reverse -S -t --time-style=full-iso --full-time -p --help --version --` and operands. None of them runs code, so registration review accepts it. Any other flag promotes the whole argv (D-037). Like D-035, this change to the definition is drafted by the agent and becomes operator-authored when the operator reviews and merges it.
  - **Protected paths (D-057, autopilot rulings).** A criterion must name 1 to 32 `protected_paths` under `/work`. Admission rejects one that lies within no source the task references. For a task that will be verified, it also rejects one that no grant for `shell.run` reaches, and a registry in which `shell.run` does not offer `/usr/bin/ls`. When a `verified` task starts, the verifier lists the protected paths: `ls -l -a -R --time-style=full-iso -- <paths>`, through the boundary, every argument a constant the criterion fixed, under the task's grants. After the criterion's command passes, it lists them again. If the two listings differ, verification fails (`protected_paths: changed`). The listing shows every entry with its size and its modification time to the nanosecond, so a write, a new file or a removed one changes it; reads do not. The comparison takes the exit code and stdout, never stderr, because the container runtime writes its own messages there and they differ on every run. A park during either listing parks the task, and a rejection fails it. The check is the more restrictive reading: it does not depend on which capability did the writing, which matters because Slice 1 has no write capability at all.
  - **The journal account (acceptance test 1).** `explainTask(root, taskId)` (`packages/runner/src/explain.ts`) reads one task's verified trajectory through the read interface and writes one plain line per meaningful entry: admission, turns, references, calls with their verdict and each argument's provenance, results, parks with their reason and detail, resumes, verification and closure. It reads nothing but the journal root.
  - **Forcing the enum change (acceptance test 4b, autopilot ruling).** The refused entry is served by a test-only subclass of `CapabilityRegistry`, declared inside the acceptance test, which returns it from `entry` and `capability` as if review had accepted it. No production code path skips review. The forced entry adds `/bin/sh` with a surface declaring `-c` as code-bearing; the test proves the mechanism (§2.3 rule 2) parks the call `integrity_floor`, with `argv[0]` and `argv[1]` promoted to the `operator` floor, even though the program itself is an operator constant.
  - **Where the tests run.** `test/acceptance/` is part of the container stage of `make verify` (`vitest.containers.config.ts`). Tests 2 and 3 run in one test, on one runner, one journal, one capability and one grant (D-057).
- Reason: the build plan's Increment 7 and §18. A digest of the protected content would need a hashing program in the image and enum. The listing needs only `ls`, which test 3 needs anyway, and it detects the same changes for content the task can reach.
