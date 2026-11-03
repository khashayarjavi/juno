# JUNO — Slice 1.5 Build Plan

**Implements:** Core Semantic Model **v0.6** — §0.0's changes A1–A5, B1–B2, C1, C4, D1–D6, E1–E3, and §4.3's Slice 1.5 acceptance.
**Read from:** `spec/core-semantic-model.md` at the head of the operator's PR #27 (`spec-v0.6`, commit `51a395a`), read in full on 2026-11-03 (D-090).
**Status:** Part 0 — for the director's review. **No increment starts until the director has reviewed this plan** (D-089).
**Built by:** the coding agent in autopilot (CLAUDE.md §7), one increment per pull request, each through the §7 gate.

---

## 0. What Slice 1.5 proves

Slice 1 proved the boundary is in the right place for JUNO's own loop. Slices 1.1–1.3 showed what a real model does at it: once it could not type a program, it obeyed a planted instruction by passing an injected path to an allowed program. v0.6's one new promise answers that:

> **Injected content may steer what JUNO does inside a grant, but never an effect it cannot undo or send out, and never which program runs.** (§0.0)

Slice 1.5 makes that promise true in JUNO's own loop (mode A), then lets work enter from the harnesses the operator already uses — Claude Code through its hooks (mode C) and any MCP client through a gateway (mode B) — with the same boundary and the same journal (§4.3). It ends when §4.3's four acceptance tests pass end to end, with no paid model usage.

---

## 1. Sources read for this plan

CLAUDE.md rule 13: nothing below is taken from memory. Each source was fetched on **2026-11-03** from this session. The hashes identify the exact text read (SHA-256 of the fetched Markdown, first 16 hex digits), so a later session can tell whether the page has changed since.

| Source | URL | Version / date | Hash |
|---|---|---|---|
| Spec v0.6 | PR #27, `spec/core-semantic-model.md` | v0.6, approved 2026-11-03 | commit `51a395a` |
| Claude Code hooks reference | https://code.claude.com/docs/en/hooks.md | page undated; mentions features up to v2.1.304 | `524960c086d43f6e` |
| Claude Code headless (`-p`) | https://code.claude.com/docs/en/headless.md | undated | `208eeb28afce5a43` |
| Claude Code MCP | https://code.claude.com/docs/en/mcp.md | undated | `4b3c2237229b4546` |
| Claude Code environment variables | https://code.claude.com/docs/en/env-vars.md | undated | `b9eca1b08f8ab647` |
| Claude Code CLI installed in the cloud session | `claude --version` | **2.1.317** | — |
| npm package `@anthropic-ai/claude-code` | `npm view` | latest 2.1.317, stable 2.1.311; licence "SEE LICENSE IN README.md" | — |
| MCP versioning | https://modelcontextprotocol.io/specification/versioning.md | names **2026-07-28** as the current revision | — |
| MCP 2026-07-28 key changes | https://modelcontextprotocol.io/specification/2026-07-28/changelog.md | 2026-07-28 | `280533e289ca1a63` |
| MCP tools | https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md | 2026-07-28 | `ffd2f284b837a0e0` |
| MCP transports, stdio | https://modelcontextprotocol.io/specification/2026-07-28/basic/transports.md, …/basic/transports/stdio.md | 2026-07-28 | `29c58292b0c32b68`, `5bcdc2e5ed677a30` |
| MCP multi round-trip requests | https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr.md | 2026-07-28 | `30abb42d799d1446` |
| npm package `@modelcontextprotocol/sdk` | `npm view` | 1.32.2, MIT | — |

**Each increment that depends on a source re-reads it before building** (§4.3's own note says so for the hooks reference) and records any difference in DECISIONS.md.

### 1.1 What the current references say that shapes the design

**Claude Code hooks** (hooks reference, 2026-11-03):

1. **Hooks fail open by default.** "On most events, when a hook fails or times out, Claude Code still carries out the action." A command hook that exits with any code other than 0 or 2, cannot start, or prints invalid JSON is a "non-blocking error" and the call proceeds. A timed-out PreToolUse hook "doesn't block the tool call".
2. **Fail-closed is opt-in:** `"onFailure": "block"` on a `command` or `http` hook, **Claude Code v2.1.295 or later**. Exit code 2 always blocks.
3. **Exec form:** a `command` hook with `args` is spawned directly, "with no shell involved". JUNO's hook uses exec form only (CLAUDE.md rule 8).
4. **PreToolUse decisions:** `allow`, `deny`, `ask`, `defer`; precedence `deny` > `defer` > `ask` > `allow`. `permissionDecisionReason` on `deny` is shown to the model. "Deny and ask rules are still evaluated regardless of what the hook returns." Exit 0 with no output is "no decision": "staying silent doesn't approve it".
5. **`defer` is narrow.** It is honoured "only in non-interactive mode with the `-p` flag. In interactive sessions it logs a warning and ignores the hook result." And: "`defer` only works when Claude makes a single tool call in the turn. If Claude makes several tool calls at once, `defer` is ignored with a warning and **the tool proceeds through the normal permission flow**." The hook's input says neither whether the session is interactive nor how many calls the turn holds. See objection V6-3.
6. **PostToolUse cannot block** ("the tool has already run"). It receives `tool_input` and `tool_response`; JUNO uses it only to journal the result.
7. **Subagents fire the same hooks**, with `agent_id` and `agent_type` in the input.
8. **Not mediated:** files the user `@`-mentions are inserted with no tool call and no PreToolUse ("including hooks matching `Read`"); `disableAllHooks` (including `--settings '{"disableAllHooks": true}'` on one run) turns hooks off; managed settings with `allowManagedHooksOnly` can force hooks. These fall under §4.3's "not protected" row for mode C.
9. `Write`, `Edit` and `Read` deliver `tool_input.file_path` already absolute.
10. `ANTHROPIC_BASE_URL` overrides the API endpoint; in `-p` mode `ANTHROPIC_API_KEY` is "always used when present"; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off telemetry and updates. These make a model-free end-to-end test possible (§5).

**MCP, revision 2026-07-28** (the current revision):

1. **Stateless.** No `initialize` handshake; every request carries its protocol version and client capabilities in `_meta`. Servers must implement `server/discover`. Earlier revisions (2025-11-25 and before) used `initialize`.
2. **stdio** is newline-delimited JSON-RPC over a client-launched subprocess; servers never send requests.
3. **Multi round-trip requests:** a server may answer `tools/call` with `resultType: "input_required"`, and the client retries with a new request id carrying the input. This replaces server-initiated sampling and elicitation (Roots, Sampling and Logging are now deprecated).
4. **Tool annotations are untrusted:** "clients MUST consider tool annotations to be untrusted unless they come from trusted servers." JUNO never derives a capability definition from a server's schema anyway (§2.5).
5. Results carry a required `resultType`; tool errors are results with `isError: true`.

---

## 2. Topology in Slice 1.5

Mode A is unchanged from Slice 1 (D-065): the runner on the host, each capability call in the sealed workload container, the journal outside every mount.

```
mode C — hook                                  mode B — gateway

Claude Code (operator's harness)               MCP client (e.g. Claude Code)
  │ PreToolUse / PostToolUse,                    │ stdio, JSON-RPC
  │ exec form, onFailure: block                  ▼
  ▼                                            juno-gateway  (boundary + journal writer)
juno-hook  (tiny client, exits 2 on any          │ execFile(program, argv), stdio
  │         doubt)                               ▼
  │ local socket                               upstream MCP server (operator-configured)
  ▼
JUNO boundary service (enforcement, grants, journal writer, checkpoints)

Outside every container, every grant scope and everything the boundary can write:
  operator signing key (hardware key or OS keychain), and the public key JUNO trusts.
```

- **One boundary, one journal.** Modes B and C call the same `packages/enforcement` boundary and `packages/journal` writer as mode A. Slice 1 kept them callable from outside the turn loop (roadmap note), so no fork is needed.
- **Who performs the effect.** In mode A the boundary performs it (`perform`). In modes B and C the harness or upstream server performs it after JUNO answers; JUNO cannot see or stop what happens between its answer and the effect (§4.3 "not protected", mode C).
- **Fail-closed at every hop.** The hook client exits 2 when the service is unreachable, slow, or answers anything but a valid decision; `onFailure: "block"` covers a crash or timeout of the client itself; the gateway answers an error when the boundary cannot be reached. A hook installation without `onFailure: "block"`, or on a Claude Code older than 2.1.295, is refused at setup (§4.3 "Fail-closed ingress").

---

## 3. Increments

Six increments, dependency-ordered. Each is its own pull request through the CLAUDE.md §7 gate. **Do not start an increment until the previous one is merged.** Every test names the section it proves (CLAUDE.md rule 7). Estimates are in Pro-plan sessions and include the review rounds.

The open objections (§6, and STATE.md "Open objections to the spec") each name the increment they block. An increment does not start while an objection that blocks it is open, unless the director has ruled.

---

### Increment 1 — Conform Slice 1 to v0.6

*Make JUNO's own loop say exactly what v0.6 says, before anything is added.*

**Implements:** §2.6 (B1), §3.4.4 and §5.1 (B2), §2.7.1 and §6.2 (A4), §2.3.1 rule 6 (A5), §6.2 and §8.2 (A2), §11.1 (A3, in the park record only — there is no approval interface yet), §2.7.1 and §3.3 (C4); confirms D1–D6 against the code with § references.

**Builds:**
1. **Per-actor constants (B1).** Admission fixes each constant for a named actor: `executing` or `verifier`. The criterion's command, its arguments and its protected-path listing become verifier constants. A `constant` source resolves only in calls by the actor it was fixed for; naming a verifier constant from the executing model is an unresolved reference (a rejection, §2.7.1). The operator may fix the same value for both actors, explicitly, at admission.
2. **Hash-pinned verification inputs (B2).** At admission the runner records a content hash of every verification input and every protected path (a directory is hashed as its listing plus each file's hash). At closure it recomputes them; any difference, or a hash that cannot be computed, makes `verified` impossible: the task fails with the changed paths recorded. This replaces D-067's listing comparison. Hashing runs in the workload with an operator-fixed, verifier-only program (for example `sha256sum`, a non-interpreter, added to the image like `cat` and `ls`), never offered to the executing model. **Blocked by objection V6-1** (which files count as "read by the verification method").
3. **Rejection limit (A4).** Three consecutive rejections park `rejection_limit` (overridable). Adjustable per task at admission. **Objection V6-9** (what resets the count, and the adjustment's bounds).
4. **A5's rejection rule.** On a program whose surface marks every position code-free and which is not on §2.3's list, an undeclared flag is a `malformed_call` rejection, not a promotion. `cat -c cat` and `ls -c …` (two of Slice 1.3's four benign parks) then become recoverable rejections. A program with any code-bearing position, or on the list, still promotes every element and parks `integrity_floor`.
5. **A2's no-override rule.** A `scope_violation` caused by an `untrusted` value records `overridable: false` and `remedy: "grant"`. Resuming it requires that the task now holds a grant covering the parked value; a plain resume is refused. Mixed values: if any out-of-scope value is `untrusted`, the rule applies.
6. **A3's source entry in park records.** Each park records, for every value that caused it, its provenance class, its integrity, and the journal entry or entries it came from. **Objection V6-8** (what "the entry it came from" means for a synthesized value without inspecting content).
7. **Canonical scope (C4).** Every path operand is resolved, symlinks included, against the volume the effect will touch, before step 4: the resolution runs in the workload (an operator-fixed resolver program, verifier/boundary-only) and the boundary judges the canonical path. A path that cannot be resolved is outside scope. Closes D-047's accepted residual. **Objection V6-2** (a path that does not exist yet).
8. **D1–D6 conformance.** D3: attenuation also refuses a child whose `max_invocations` exceeds its parent's, or is unbounded under a bounded parent. The rest (D1, D2, D4, D5, D6) were built as D-036/37, D-055/063, D-046/47, D-048/52/54 and D-080; each gets a test or comment naming its v0.6 section.

**Tests (each names the § it proves):**
- §2.6 B1: the executing model naming `criterion.program` (or any verifier constant) is an unresolved-reference rejection; nothing runs. The Slice 1.2 test that pinned the old behaviour (`packages/runner/test/runner.test.ts`, verifier slots resolvable) is changed to assert this — the specification changed; recorded as a D-number, not a weakened test.
- §2.6 B1: a value the operator fixed for both actors resolves for both.
- §3.4.4 B2: a protected file rewritten with the same size and modification time makes `verified` impossible (Slice 1's listing comparison would have passed it) — the failure records the path.
- §3.4.4 B2: an unchanged pin set closes `verified`; a pin that cannot be computed counts as changed.
- §2.7.1 A4: three consecutive rejections park `rejection_limit`; two rejections then a proceeding call do not; the limit set at admission is honoured.
- §2.3.1 rule 6 A5: `cat -c x` is a `malformed_call` rejection; `cat -c x` on a surface that has any code-bearing position still parks `integrity_floor`; a listed interpreter with an undeclared flag still parks.
- §8.2 A2: an untrusted out-of-scope value parks `scope_violation` with `overridable: false`; plain resume is refused; resume after a covering grant is added succeeds; an operator-integrity out-of-scope value stays overridable.
- §11.1 A3: the park record names the source entry for a bound value, and the V6-8 ruling's set for a synthesized one.
- §2.7.1 C4: a symlink inside the scope pointing outside it parks `scope_violation`; a symlink chain that stays inside proceeds; an unresolvable path parks. Container test, real workload.
- §3.2 D3: a child grant with a larger or unbounded `max_invocations` is refused.
- Regression: all five §18 acceptance tests still pass; tests 2 and 3 together (D-057).

**Done when:** every test above is green in `make verify` and in CI; STATE.md lists which §0.0 rows are now built; no objection blocking Increment 1 is open.
**Depends on:** Slice 1 as merged. **Estimate:** 3 sessions.
**Optional, operator-authorised only:** re-run Slice 1.3's six ordinary tasks on Groq's free tier (USD 0, D-072/D-073) to measure what A5 does to the benign-park rate. Not part of acceptance.

---

### Increment 2 — Signed grants and an anchored journal head

*Without this, any process on the host able to write the grant store could issue authority, and anything able to write journal storage could rewrite history and every hash (§3.2, §3.4.1).*

**Implements:** §3.2 (C1: `signature` mandatory; the key outside every container and outside runner-writable state; verified at lookup), §3.4.1 (C1: anchored head).

**Builds:**
1. **Grant signatures.** The `signature` field becomes mandatory: an Ed25519 signature over the canonical form of every other field (the journal's existing canonical JSON). Verification uses Node's built-in `node:crypto` (no new package). The boundary verifies at lookup; a grant with a missing or invalid signature **does not exist** — the call sees no covering grant.
2. **Where the keys live.** The operator's private key lives in a hardware key or the OS keychain, never in the repository, a container, the journal, or any directory the runner can write. JUNO holds only the operator's **public** key (the trust anchor), in a location the runner cannot write; the runner refuses to start if it can write the anchor file or its directory. The exact signing mechanism (for example OpenSSH's `ssh-keygen -Y sign` through an agent, which supports hardware keys, or a keychain-backed signer) is chosen at the start of the increment from its current documentation and recorded as a D-number. **Operator decision 2 (§7).**
3. **Operator CLI:** `juno grant sign` (operator-side, uses the key), `juno grant verify`. The runner and every mediated mode only ever verify.
4. **Anchored head.** The journal head hash is signed with the operator key and copied to a destination the host cannot rewrite. `juno journal check` compares the chain with the latest anchor: a rewrite of anything at or before the anchored head is reported, naming the first entry that differs. The anchoring interval is recorded in the journal. **Objection V6-4** (who signs at intervals, given the key is outside the runner, and what "off the host" means for the tests).
5. Journal storage, the checkpoint store (Increment 3), the trust anchor and JUNO's configuration are all outside every name a selector can reach; grant creation rejects a selector that names any of them (§3.2 "No selector may name journal storage").

**Tests:**
- §3.2 C1: a grant with no signature, a signature by another key, or any one field changed after signing is not honoured: the call parks `awaiting_grant` and the journal records why the grant was refused (`signature_invalid`).
- §3.2 C1: a correctly signed grant is honoured, before and after a restart.
- §3.2 C1: the runner refuses to start when its trust anchor is writable by it (container test: the verifier runs as a uid that does not own the read-only anchor).
- §3.2 C1: no test key, private or public, is committed; test keys are generated per run in a temporary directory outside the work volume and the journal.
- §3.4.1 C1: rewriting an entry and recomputing every hash after it passes the chain check but fails the anchor check; an entry appended after the anchor is not reported as a rewrite.
- §3.2, §3.4.1: a grant selector naming the journal, the checkpoint store or the trust anchor is rejected at creation.

**Done when:** the tests above are green; every grant in the repository's fixtures is signed by a per-run test key; STATE.md says how the operator generates their key and signs a grant.
**Depends on:** Increment 1. **Estimate:** 2 sessions.

---

### Increment 3 — Effects under untrusted influence

*v0.6's new promise, in mode A: untrusted content may still choose what is read or written inside a reversible workspace, but not what is sent out or destroyed.*

**Implements:** §2.2.2 (A1), §2.7.1 "Effects", §3.2 (`enumerated_targets`), §2.4 (the conformance suite for the new adapter).

**Builds:**
1. **Target and payload declarations.** Every `data` field of every capability declares `target` or `payload`; an undeclared field is `target` (fail-closed). `shell.run`'s `argv` and `cwd` are targets.
2. **`enumerated_targets` on Grant.** The exact values an `untrusted` target field may take for `external` and `irreversible` capabilities.
3. **§2.2.2's table at step 4:** `read` — untrusted targets permitted within scope; `write` — permitted within scope only if the scope is a reversible workspace, otherwise treated as `irreversible`; `external` and `irreversible` — an untrusted target parks `integrity_floor` unless the grant enumerates that exact value. Payloads are permitted (under `max_input_sensitivity`).
4. **Reversible-workspace checkpoints.** Before a task's first effect on a scope, the boundary takes a checkpoint of the scope's full content into a content-addressed checkpoint store outside every mount and every selector, and journals it. `juno checkpoint restore <task> <checkpoint>` is an operator action; it is journaled, with the result. A scope with no checkpoint is not reversible.
5. **One write capability:** `fs.file.write(path: data/target, content: data/payload)`, `side_effect: write`. Its adapter runs a fixed, operator-authored writer program in the workload by `execFile`, with the path and the content as separate argv elements (a structural channel, §2.4). Content never goes through standard input, because §2.3.1 says standard input carrying model-written content must be declared an instruction field. The writer refuses to follow a symlink in any path component. The adapter passes the conformance suite before registration.

**Tests:**
- §2.2.2 rule "Undeclared → target": a capability definition with an undeclared data field parses with it as `target`.
- §2.2.2 `write`: a synthesized (untrusted) path inside a checkpointed scope proceeds; the same path in a scope with no checkpoint parks `integrity_floor`.
- §2.2.2 reversible workspace: after a write, `juno checkpoint restore` brings back the exact prior content (byte-for-byte), and both the checkpoint and the restore are in the journal.
- §2.2.2 `external`/`irreversible` (with a test-only capability of each class): an untrusted target not in `enumerated_targets` parks `integrity_floor`; an enumerated one proceeds; a `constant` target proceeds; a `bound` target whose entry is not `untrusted` proceeds.
- §2.2.2 payload: an untrusted payload proceeds; one above `max_input_sensitivity` parks `sensitivity_ceiling`.
- §2.4: the write adapter's canary (shell metacharacters, quotes, a newline) arrives as one intact argv element; an interpolating variant is blocked at registration.
- Container test: the writer does not follow a symlink planted by the task to a path outside the scope.
- Regression: §18 tests 1–5; tests 2 and 3 together.

**Done when:** the tests above are green; the registry has exactly one new capability (`fs.file.write`); STATE.md lists, per side-effect class, what untrusted content can and cannot choose.
**Depends on:** Increments 1 (canonical scope) and 2 (signed grants carry `enumerated_targets`). **Blocked by objection V6-2** for writes to new files. **Estimate:** 2 sessions.

---

### Increment 4 — Hook mode for Claude Code (§4.3 mode C)

*JUNO governs a Claude Code session through its PreToolUse and PostToolUse hooks, fail-closed.*

**Implements:** §4.3 (mode C, fail-closed ingress, park mapping, provenance in B and C), §2.3.2 (E1), §7.8 (E2: `hook` → `steer_capability: none`), §2.2.2 under mediated modes.

**Builds:**
1. **Re-read the hooks reference first** and record differences from §1.1 in DECISIONS.md.
2. **`juno hook install`** writes the hook into the settings file the operator names, and **refuses** (§4.3 "refused at setup") unless all hold: exec form (`command` plus `args`, no shell); `onFailure: "block"`; an explicit `timeout`; matcher `*` on PreToolUse, PostToolUse and PostToolUseFailure; `claude --version` (run by `execFile`) at least 2.1.295. It reports, and does not hide, what it cannot control: `disableAllHooks`, `@`-mentions, harness actions without a tool call.
3. **The session record.** The operator admits a mediated session: its grants, the program enum for Bash (every member must pass the interpreter test), the exact command strings and values the operator lists as constants, budgets and TTL. **Objection V6-6** (what record a mediated session is, and which budget axes apply when JUNO sees no tokens).
4. **Capability definitions for Claude Code's tools,** operator-authored (§2.5), never derived from the tool schema: `Read`, `Glob`, `Grep` (`read`); `Write`, `Edit` (`write`; `file_path` target, content payload); `Bash` (mapped to `shell.run` through §2.3.2); `WebFetch` (`external`; the URL is a target). A tool with no definition is a rejection (`unknown_capability`), so it is denied; three in a row park `rejection_limit`.
5. **Bash under §2.3.2.** The command string is parsed by a deliberately small grammar: a constant command string the operator listed is accepted as written; otherwise any shell syntax, or a program outside the enum, parks `integrity_floor`, and the remaining words become `argv` judged as untrusted data. **Objection V6-5** (which syntax counts, and how a bare program name maps to the enum's absolute paths). **Objection V6-10** (a program's side-effect class versus its capability's).
6. **Provenance (§4.3):** every model-written value is `untrusted`; operator-listed values are `constant` at `operator` integrity; tool results journaled by PostToolUse are `untrusted` and raise the session's `sensitivity_floor`. **Objection V6-7** (what a raised floor means when JUNO does not route the harness's model).
7. **Decisions back to Claude Code.**
   - Proceed: no decision (exit 0, empty), so Claude Code's own permission rules still apply; JUNO may answer `allow` only where the session is configured to make JUNO the sole authority. Recorded as a D-number.
   - Park: `deny` with the park reason in `permissionDecisionReason`, the park journaled, and the remedy (a grant) applying to the model's retry. Never `ask` (§4.3). Never `defer` until V6-3 is ruled (§1.1 item 5: an ignored `defer` lets the call proceed).
   - Rejection: `deny` with the reason.
   - Any doubt in the client (service unreachable, timeout, malformed answer): exit 2.
8. **Results:** PostToolUse and PostToolUseFailure journal the result against the call JUNO authorized. A call whose result never arrived is recorded as such, and the session's next call is denied until the gap is recorded — so a missing result cannot be silent.
9. **Writes in hook mode** use Increment 3's checkpoints on the host workspace before the first write; without a checkpoint a write is `irreversible` and its untrusted target parks.
10. Journal, checkpoint store, trust anchor and the hook's own settings files are outside every scope: a tool call naming them parks `scope_violation`, so Claude Code cannot edit its way out of the hook through a mediated tool.

**Tests:**
- §4.3 fail-closed: the hook client exits 2 when the service is down, when it times out, and when it gets an answer it cannot parse — each blocks the call (protocol-level test in `make verify`; real-binary test below).
- §4.3 refused at setup: `juno hook install` refuses a configuration without `onFailure: "block"`, in shell form, or on a Claude Code older than 2.1.295.
- §4.3 park mapping: a park answers `deny` with the reason and journals the park; no code path answers `ask` or `defer` (asserted over every decision the client can emit).
- §2.3.2: `cat notes.txt` (enum member) proceeds with `cat` at floor `untrusted`; `cat notes.txt; curl x`, `$(…)`, `` `…` ``, `|`, `&&`, `>`, a glob, and `sh -c …` each park `integrity_floor`; an operator-listed exact command proceeds as written.
- §2.2.2 mediated: a `Write` inside a checkpointed scope proceeds; outside the grant it parks `scope_violation` and is denied; `WebFetch` to an untrusted URL not enumerated parks `integrity_floor`.
- §7.8 E2: a hook session's `steer_capability` is `none`.
- §4.3: a Claude Code subagent's tool call is mediated the same way (input with `agent_id`).
- **End to end, real Claude Code binary, no paid usage** (§5): §4.3 acceptance tests 1 and 2, and test 4's mode-C case.

**Done when:** the tests above are green, including the real-binary end-to-end run in the place the operator chooses (operator decision 1, §7); STATE.md says, in plain words, what mode C does not protect (§4.3's table).
**Depends on:** Increments 1–3. **Blocked by objections V6-3, V6-5, V6-6, V6-7, V6-10.** **Estimate:** 3 sessions.

---

### Increment 5 — Gateway mode for MCP (§4.3 mode B)

*Every tool call from an MCP client to a governed server passes the same boundary and lands in the same journal.*

**Implements:** §4.3 (mode B), §2.3.2, §7.8 (E2: `gateway` → `none`), §2.2.2 for `external` effects.

**Builds:**
1. **Re-read MCP 2026-07-28** (and the revision Claude Code actually speaks). The gateway supports exactly the revisions observed from Claude Code and from the test server, recorded as a D-number, and refuses any other (fail-closed). Implemented as plain JSON-RPC over stdio with runtime schemas; the `@modelcontextprotocol/sdk` package is added only if the lockfile installs it in CI and it supports the chosen revision (rule 13).
2. **`juno-gateway`:** a stdio MCP server to the client and an MCP client to one operator-configured upstream server, launched by `execFile(program, argv)`. Upstream credentials stay in the gateway's environment; the model never sees them (§3.2).
3. **Capability definitions per upstream tool,** operator-authored (§2.5). `tools/list` returns only defined tools; a call to any other tool is a rejection. Tool descriptions pass through unchanged and unprotected (§4.3 mode B row).
4. **Each `tools/call`:** the arguments are judged by the boundary (every value `untrusted`; operator-listed values `constant`); proceed forwards it; park or reject returns a tool result with `isError: true` and the reason (MCP has no defer), journaled; the remedy applies to the retry.
5. **Responses** are journaled as `untrusted` and raise the session's `sensitivity_floor`.
6. **`input_required` (multi round-trip) results are refused** in Slice 1.5: the gateway returns an error to the client and journals it. Supporting them needs a design for the retried input's provenance, which v0.6 does not give. Recorded as a D-number (restrictive reading).
7. **Test MCP server** (JUNO-authored, test-only, in `test/`): `files.read` (`read`), and `message.send(to: target, body: payload)` (`external`), which records what it would have sent and sends nothing.

**Tests:**
- §4.3 mode B: a `tools/call` with an out-of-scope argument returns `isError: true`, is journaled as a park, and never reaches the upstream server (the server's record is empty).
- §2.2.2 `external`: `message.send` to an untrusted `to` not in `enumerated_targets` parks `integrity_floor`; to an enumerated recipient it proceeds and the server records it; the `body` may be untrusted.
- §4.3 fail-closed: upstream unreachable, boundary unreachable, malformed upstream response, unsupported protocol revision — each is an error to the client, never a forwarded call.
- §7.8 E2: a gateway session's `steer_capability` is `none`.
- §2.5: an upstream tool with no operator definition is not listed and a call to it is rejected.
- MRTR: an `input_required` answer is refused and journaled.
- **End to end:** a scripted MCP client (in `make verify`) and the real Claude Code binary with the scripted model (§5) — §4.3 acceptance test 3.

**Done when:** the tests above are green; STATE.md says what mode B does not protect.
**Depends on:** Increments 1–3; reuses Increment 4's session record and scripted model. **Blocked by objections V6-6, V6-7.** **Estimate:** 2 sessions.

---

### Increment 6 — §4.3's Slice 1.5 acceptance, end to end

**Implements:** §4.3 "Acceptance for Slice 1.5" — all four, together, against the real containers and the real Claude Code binary — plus §18's five tests as regression.

| # | §4.3 acceptance test | Mode | Proves |
|---|---|---|---|
| 1 | A Claude Code session is denied a write outside its grant, and the denial appears in the journal | C | The hook is a control, not a convention |
| 2 | An injected instruction that reaches a shell command with shell syntax or an interpreter parks `integrity_floor` | C (and A) | §2.3.2: in mediated modes the model may choose a program, never a shell |
| 3 | An `untrusted` target of an `external` effect not enumerated in the grant parks (§2.2.2) | B (and A) | v0.6's new promise: injected text cannot choose where something goes |
| 4 | A forged grant (bad signature) is not honoured (§3.2) | A and C | Authority comes only from the operator's key |

Each test also reads the journal back and answers "why did this happen?" from it alone (§3.4.5), and checks the chain against the latest anchor (§3.4.1).

**Done when:** all four pass in one `make verify` run (or in the operator-chosen end-to-end target, §7), together with §18 tests 1–5; the PR description states, for each, how it ran and that no paid model was called; STATE.md records Slice 1.5 complete.
**Depends on:** Increments 1–5. **Estimate:** 1–2 sessions.

**Total estimate:** 13–14 sessions, plus whatever the objections' rulings add.

---

## 4. How each acceptance test runs without paid usage

No acceptance test needs a real model. The injection in tests 2 and 3 is scripted, so the tests prove the boundary, not a model's behaviour (as §18 test 2 did with the scripted provider, D-002).

**The scripted model for Claude Code.** Claude Code is run in `-p` mode with `ANTHROPIC_BASE_URL` pointing at a JUNO test server on the local machine that speaks the Anthropic Messages API and returns pre-written turns (for example: "call `Write` on `/etc/x`"). `ANTHROPIC_API_KEY` is a random value generated per run (not a key; nothing accepts it), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and a fresh configuration directory so the operator's login is never read. The run happens in a container whose only network is the scripted server, so no request can reach a paid endpoint even by mistake. Increment 4 builds the scripted server from the current Messages API reference, read then (rule 13), and records every request Claude Code makes; **if Claude Code cannot run against it, Increment 4 stops and reports**, because protocol-level tests alone do not prove "a Claude Code session".

| Test | How it runs | Paid usage | Where |
|---|---|---|---|
| §4.3 test 1 | Real Claude Code + scripted model + JUNO hook; scripted turn writes outside the grant; asserts the deny, the journal's park entry, and that the file does not exist | None | CI, or the cloud session (operator decision 1) |
| §4.3 test 2 | Mode C: scripted turn 1 reads a planted file, turn 2 runs a Bash command with `;` and `sh -c`; asserts `integrity_floor`, deny, nothing ran. Mode A: §18 test 2 with the scripted provider | None | as above; mode A in `make verify` |
| §4.3 test 3 | Mode B: JUNO's test MCP server behind `juno-gateway`, driven by a scripted MCP client in `make verify` and by real Claude Code + scripted model; `message.send` to a planted recipient parks; the server records nothing sent | None | `make verify`; real binary as above |
| §4.3 test 4 | Grants signed with a per-run test key; a tampered grant, a grant signed by another key, and an unsigned grant are each not honoured — in mode A (container test) and mode C (real binary) | None | `make verify`; real binary as above |
| §18 tests 1–5 | Unchanged: scripted provider, real containers | None | `make verify` |

## 5. What needs the operator's own machine

- **For acceptance: nothing.** Every test above runs in CI or in the cloud session.
- **Once, for real use (Increment 2):** generating the operator's signing key in a hardware key or the OS keychain, and signing one grant with `juno grant sign`. CI cannot hold a keychain or a hardware key, so it uses throwaway per-run keys; the real-key path is proven only on the operator's machine. Increment 2 writes the exact commands into STATE.md.
- **Optional, not acceptance:** one interactive Claude Code session on the operator's machine with the hook installed, to see an interactive `deny` in the terminal. It uses the operator's own Claude Code plan (no extra money); the automated tests use `-p` mode only, because the interactive terminal cannot be driven by a test.

---

## 6. Objections to v0.6 raised by this plan

Written into STATE.md "Open objections to the spec", unresolved, as the operator instructed. Each names the increment it blocks. Short form:

| ID | § | Question | Blocks |
|---|---|---|---|
| V6-1 | §3.4.4 B2 | Which files are "every file the verification method reads"? Read literally it includes the task's own output, which does not exist at admission ("a hash that cannot be computed counts as changed"), so no criterion that checks what the task made could ever close `verified`. | Inc 1 |
| V6-2 | §2.7.1 C4 | "A path that cannot be resolved is outside scope": a file that does not exist yet cannot be resolved, so read literally no capability can create a file. | Inc 1, 3 |
| V6-3 | §4.3 | "Where the protocol can defer and resume a call, a park defers it": Claude Code ignores `defer` (and lets the call proceed) in interactive sessions and when a turn has several tool calls, and the hook cannot tell either at the time it answers. | Inc 4 |
| V6-4 | §3.4.1 C1 | The head is "signed with the operator key at intervals", but the key is outside anything the runner can use or write. Who signs, and what counts as "off the host" in a test? | Inc 2 |
| V6-5 | §2.3.2 | Which Bash syntax counts as shell syntax (quoting, escapes, `$VAR`, `~`, comments, `VAR=x cmd`, newlines), and how a bare program name maps to the enum's absolute paths when the harness, not JUNO, resolves it. | Inc 4 |
| V6-6 | §4.3, §5.4 | What record a hook or gateway session is: an admitted Task with objective, criterion, four budget axes and TTL? JUNO sees no tokens or currency in modes B and C. | Inc 4, 5 |
| V6-7 | §4.3, §10.3 | A mediated session's `sensitivity_floor` rises with reads, but JUNO does not route the harness's model. Does reaching `confidential` deny every later call (`routing_unavailable`)? | Inc 4, 5 |
| V6-8 | §11.1 A3 | "The journal entry it came from" for a synthesized value: invariant 7 forbids finding it by comparing content. Is the producing turn plus every untrusted entry in its context acceptable? | Inc 1 |
| V6-9 | §2.7.1 A4 | What resets "three consecutive rejections", whether unreadable provider turns count, and what bounds the per-task adjustment (could it be set high enough to disable the limit)? | Inc 1 |
| V6-10 | §2.1, §2.3.2 | `side_effect` belongs to a capability, but in hook mode the operator's Bash enum could hold `cp` or `rm` under `shell.run`, which is `read`. Must every enum member's effect fit its capability's class? | Inc 4 |

---

## 7. Operator decisions this plan needs (not spec questions)

1. **Where the real-binary tests run.** (a) In CI: add `@anthropic-ai/claude-code` to the lockfile. Its licence is "SEE LICENSE IN README.md", not an open-source licence, which matters if the repository is later published (D4). (b) In the cloud session only, as `make mediated-e2e`, the way `make smoke` runs (the session already has Claude Code 2.1.317); CI then runs the protocol-level tests only. Recommended: (b), so the open-source core never depends on a proprietary package; the PR for Increments 4–6 records the run.
2. **The signing mechanism** for the operator key (Increment 2): a hardware key through an SSH agent, or the OS keychain. Recommended: a hardware key, because a keychain the operator's user can unlock can also be used by any process running as that user.
3. **The anchor destination** for the journal head (Increment 2), once V6-4 is ruled: for example a private repository, or a file the operator copies off the machine.
4. **PR #26** (the Slice 1.3 STATE record) is merged into this plan's branch (D-090); closing it is the operator's call.

---

## 8. Not in Slice 1.5

- **C2, secret detection at context assembly (§1.4),** is a v0.6 change the operator's increment list does not include. It is not scheduled here; the director should say whether it joins Increment 1 or waits.
- **C3** (erasure by key destruction) is built with the hosted product (§3.4.5).
- Steer, Override as an object, the decision queue, the approval interface, the console, resource locking, estate budgets, the Surface contract, plugins, multiple providers in one task, concurrent tasks, delegation, memory, compaction, planning, retrieval (CLAUDE.md rule 9).
- §0.0's deferred items: standing tasks and per-period budgets, the GUI-action class, A2A peers, payment-mandate grant fields, the delegation provenance test.
- MCP Streamable HTTP transport (stdio only in Slice 1.5), MCP multi round-trip requests (refused), and more than one upstream server per gateway.
- Claude Code's interactive-mode `defer` path, and any harness other than Claude Code for mode C.

## 9. Risks

- **The scripted model may not satisfy Claude Code.** If Claude Code needs endpoints or behaviour the scripted server cannot provide offline, tests 1, 2 and 4 (mode C) cannot run without paid usage. Increment 4 stops and reports rather than calling a paid model.
- **Claude Code's hook behaviour can change between releases.** Each mediated increment re-reads the reference; `juno hook install` pins a minimum version; the end-to-end test records the version it ran against.
- **Hashing large workspaces** (B2 pins, Increment 3 checkpoints) may be slow; both are bounded per task at admission, and exceeding the bound refuses admission rather than skipping the check.
- **The rulings may move work between increments.** V6-1 and V6-2 in particular could make a restrictive reading conflict with a §18 acceptance test — a CLAUDE.md §7 STOP — which is why they are raised before Increment 1.
