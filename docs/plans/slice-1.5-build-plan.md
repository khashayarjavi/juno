# JUNO — Slice 1.5 Build Plan

**Implements:** Core Semantic Model **v0.6.1** — §0.0's changes A1–A5, B1–B2, C1, C4, D1–D6, E1–E3, the ten v0.6.1 clarifications, and §4.3's Slice 1.5 acceptance. C2 is deferred to Slice 2 (D-095).
**Read from:** `spec/core-semantic-model.md` at commit `fcb1a60` (branch `spec-v0.6`, head of the operator's PR #27, open and not yet merged), the v0.6 text read in full on 2026-11-03 (D-090), the v0.6.1 sections re-read on 2026-11-03 (D-096), and fcb1a60's one change over `4267e04` (§0.0 and §3.4.1, V61-1) read on 2026-11-03 (D-098).
**Status:** Part 0, revised to the operator's rulings of 2026-11-03 (D-091 to D-095). **No increment starts until v0.6.1 is on `main`** (D-096): PR #27 was closed without merging, so `main` still carries v0.5.1.
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
| Spec v0.6.1 | PR #27 (open, not merged on 2026-11-03), `spec/core-semantic-model.md` | v0.6.1, 2026-11-03 | commit `fcb1a60` (4267e04 plus V61-1) |
| GitHub plans | https://docs.github.com/en/get-started/learning-about-github/githubs-plans | read 2026-11-03 | protected branches in private repositories are a GitHub Pro feature (V61-1) |
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
5. **`defer` is narrow.** It is honoured "only in non-interactive mode with the `-p` flag. In interactive sessions it logs a warning and ignores the hook result." And: "`defer` only works when Claude makes a single tool call in the turn. If Claude makes several tool calls at once, `defer` is ignored with a warning and **the tool proceeds through the normal permission flow**." The hook's input says neither whether the session is interactive nor how many calls the turn holds. **Ruled by §4.3 (v0.6.1, V6-3): in hook and gateway modes a park always denies; `defer` is never used.**
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
  operator signing key (Windows OS keychain, D-093), and the public key JUNO trusts.
Held by the runner, outside every mount and selector: the journal key, which signs anchors only (§3.4.1, v0.6.1).
Off the host: the anchor destination (append-only; in tests, a separate append-only container, §3.4.1).
```

- **One boundary, one journal.** Modes B and C call the same `packages/enforcement` boundary and `packages/journal` writer as mode A. Slice 1 kept them callable from outside the turn loop (roadmap note), so no fork is needed.
- **Who performs the effect.** In mode A the boundary performs it (`perform`). In modes B and C the harness or upstream server performs it after JUNO answers; JUNO cannot see or stop what happens between its answer and the effect (§4.3 "not protected", mode C).
- **Fail-closed at every hop.** The hook client exits 2 when the service is unreachable, slow, or answers anything but a valid decision; `onFailure: "block"` covers a crash or timeout of the client itself; the gateway answers an error when the boundary cannot be reached. A hook installation without `onFailure: "block"`, or on a Claude Code older than 2.1.295, is refused at setup (§4.3 "Fail-closed ingress").

---

## 3. Increments

Six increments, dependency-ordered. Each is its own pull request through the CLAUDE.md §7 gate. **Do not start an increment until the previous one is merged.** Every test names the section it proves (CLAUDE.md rule 7). Estimates are in Pro-plan sessions and include the review rounds.

The ten objections the first draft raised (V6-1 to V6-10) are resolved by v0.6.1 (D-091; §6 below says where). V61-1, raised against v0.6.1 itself, is ruled (a) public (D-098) and resolved in §3.4.1 at fcb1a60 (branch `spec-v0.6`). No objection is open. An increment does not start while an objection that blocks it is open, unless the director has ruled.

---

### Increment 1 — Conform Slice 1 to v0.6

*Make JUNO's own loop say exactly what v0.6 says, before anything is added.*

**Implements:** §2.6 (B1), §3.4.4 and §5.1 (B2), §2.7.1 and §6.2 (A4), §2.3.1 rule 6 (A5), §6.2 and §8.2 (A2), §11.1 (A3, in the park record only — there is no approval interface yet), §2.7.1 and §3.3 (C4); confirms D1–D6 against the code with § references.

**Builds:**
1. **Per-actor constants (B1).** Admission fixes each constant for a named actor: `executing` or `verifier`. The criterion's command, its arguments and its protected-path listing become verifier constants. A `constant` source resolves only in calls by the actor it was fixed for; naming a verifier constant from the executing model is an unresolved reference (a rejection, §2.7.1). The operator may fix the same value for both actors, explicitly, at admission.
2. **Hash-pinned verification inputs (B2).** At admission the runner records a content hash of every verification input and every protected path (a directory is hashed as its listing plus each file's hash). At closure it recomputes them; any difference, or a hash that cannot be computed, makes `verified` impossible: the task fails with the changed paths recorded. This replaces D-067's listing comparison. Hashing runs in the workload with an operator-fixed, verifier-only program (for example `sha256sum`, a non-interpreter, added to the image like `cat` and `ls`), never offered to the executing model. **What is pinned (§3.4.4, v0.6.1):** the criterion declares **outputs** (never pinned) and **verification inputs** (pinned by hash, or as absent if they do not exist at admission). Because JUNO cannot see what a command reads, every other file in the verification scope is treated as an input, and the scope's listing is pinned, so a file the task creates that is not a declared output makes `verified` impossible (D-097). Every §18 fixture's criterion declares its outputs; if that reading makes a §18 test impossible, the increment STOPs (CLAUDE.md §7).
3. **Rejection limit (A4).** Three consecutive rejections park `rejection_limit` (overridable). **§2.7.1 (v0.6.1):** the count resets when a call proceeds, when a call parks, and on resume; it may be set per task at admission from 1 to 10 (default 3); admission refuses any other value. A turn the runner cannot read is not a call, so it is not a rejection: it neither counts nor resets (D-091).
4. **A5's rejection rule.** On a program whose surface marks every position code-free and which is not on §2.3's list, an undeclared flag is a `malformed_call` rejection, not a promotion. `cat -c cat` and `ls -c …` (two of Slice 1.3's four benign parks) then become recoverable rejections. A program with any code-bearing position, or on the list, still promotes every element and parks `integrity_floor`.
5. **A2's no-override rule.** A `scope_violation` caused by an `untrusted` value records `overridable: false` and `remedy: "grant"`. Resuming it requires that the task now holds a grant covering the parked value; a plain resume is refused. Mixed values: if any out-of-scope value is `untrusted`, the rule applies.
6. **A3's source entry in park records.** Each park records, for every value that caused it, its provenance class, its integrity, and its source: for a `bound` value, the referenced entry; **for a `synthesized` value (§11.1, v0.6.1)**, the untrusted entries in the model's context since the last operator input, listed as "possible sources". No content is compared (invariant 7).
7. **Canonical scope (C4).** Every path operand is resolved, symlinks included, against the volume the effect will touch, before step 4: the resolution runs in the workload (an operator-fixed resolver program, verifier/boundary-only) and the boundary judges the canonical path. A path that cannot be resolved is outside scope. **A path that does not exist yet (§2.7.1, v0.6.1)** is resolved through its longest existing ancestor: the ancestor is canonicalized and must lie in scope; the missing remainder must contain no `..`, no symlink and no empty component. Closes D-047's accepted residual.
8. **D1–D6 conformance.** D3: attenuation also refuses a child whose `max_invocations` exceeds its parent's, or is unbounded under a bounded parent. The rest (D1, D2, D4, D5, D6) were built as D-036/37, D-055/063, D-046/47, D-048/52/54 and D-080; each gets a test or comment naming its v0.6 section.

**Tests (each names the § it proves):**
- §2.6 B1: the executing model naming `criterion.program` (or any verifier constant) is an unresolved-reference rejection; nothing runs. The Slice 1.2 test that pinned the old behaviour (`packages/runner/test/runner.test.ts`, verifier slots resolvable) is changed to assert this — the specification changed; recorded as a D-number, not a weakened test.
- §2.6 B1: a value the operator fixed for both actors resolves for both.
- §3.4.4 B2: a protected file rewritten with the same size and modification time makes `verified` impossible (Slice 1's listing comparison would have passed it) — the failure records the path.
- §3.4.4 B2: an unchanged pin set closes `verified`; a pin that cannot be computed counts as changed; a declared output the task creates or changes does not prevent `verified`; a verification input absent at admission that the task creates, or any new file that is not a declared output, makes `verified` impossible.
- §2.7.1 A4: three consecutive rejections park `rejection_limit`; two rejections then a proceeding call do not; a park and a resume each reset the count; a limit of 1 and of 10 is honoured, and 0 or 11 is refused at admission; an unreadable turn neither counts nor resets.
- §2.3.1 rule 6 A5: `cat -c x` is a `malformed_call` rejection; `cat -c x` on a surface that has any code-bearing position still parks `integrity_floor`; a listed interpreter with an undeclared flag still parks.
- §8.2 A2: an untrusted out-of-scope value parks `scope_violation` with `overridable: false`; plain resume is refused; resume after a covering grant is added succeeds; an operator-integrity out-of-scope value stays overridable.
- §11.1 A3: the park record names the referenced entry for a bound value, and the untrusted entries since the last operator input as "possible sources" for a synthesized one.
- §2.7.1 C4: a symlink inside the scope pointing outside it parks `scope_violation`; a symlink chain that stays inside proceeds; a symlink loop parks; a new file whose longest existing ancestor is in scope proceeds; a missing remainder with `..` or an empty component parks. Container test, real workload.
- §3.2 D3: a child grant with a larger or unbounded `max_invocations` is refused.
- Regression: all five §18 acceptance tests still pass; tests 2 and 3 together (D-057).

**Done when:** every test above is green in `make verify` and in CI; STATE.md lists which §0.0 rows are now built; no objection blocking Increment 1 is open.
**Depends on:** Slice 1 as merged, and v0.6.1 on `main` (D-096). **Estimate:** 3 sessions.
**Optional, operator-authorised only:** re-run Slice 1.3's six ordinary tasks on Groq's free tier (USD 0, D-072/D-073) to measure what A5 does to the benign-park rate. Not part of acceptance.

---

### Increment 2 — Signed grants and an anchored journal head

*Without this, any process on the host able to write the grant store could issue authority, and anything able to write journal storage could rewrite history and every hash (§3.2, §3.4.1).*

**Implements:** §3.2 (C1: `signature` mandatory; the key outside every container and outside runner-writable state; verified at lookup), §3.4.1 (C1: anchored head).

**Builds:**
1. **Grant signatures.** The `signature` field becomes mandatory: an Ed25519 signature over the canonical form of every other field (the journal's existing canonical JSON). Verification uses Node's built-in `node:crypto` (no new package). The boundary verifies at lookup; a grant with a missing or invalid signature **does not exist** — the call sees no covering grant.
2. **Where the keys live.** The operator's private key lives in the **Windows OS keychain** on the operator's machine (D-093), never in the repository, a container, the journal, or any directory the runner can write. JUNO holds only the operator's **public** key (the trust anchor), in a location the runner cannot write; the runner refuses to start if it can write the anchor file or its directory. The exact Windows signing mechanism is chosen at the start of the increment from its current documentation (rule 13) and recorded as a D-number. Tests generate a throwaway key per run (D-093).
3. **Operator CLI:** `juno grant sign` (operator-side, uses the key), `juno grant verify`. The runner and every mediated mode only ever verify.
4. **Anchored head (§3.4.1, v0.6.1).** At a recorded interval the runner signs the journal head hash with a separate **journal key** it holds (never the operator key, which never enters the runner) and copies it to an append-only destination off the host. The signature only says which runner wrote the anchor; the protection is the copy. `juno journal check` compares the chain with the latest anchor: a rewrite of anything at or before the anchored head is reported, naming the first entry that differs. **In tests** the destination is a separate container exposing an append-only interface over its own volume. **For real use** it is the operator's **public** GitHub repository `juno-anchors` (D-094, D-098; §3.4.1 v0.6.1), whose history is protected against force-push and deletion, pushed to by a credential scoped to that repository alone. Anchors hold only hashes, sequence numbers, times and signatures — no task content.
5. Journal storage, the checkpoint store (Increment 3), the trust anchor and JUNO's configuration are all outside every name a selector can reach; grant creation rejects a selector that names any of them (§3.2 "No selector may name journal storage").

**Tests:**
- §3.2 C1: a grant with no signature, a signature by another key, or any one field changed after signing is not honoured: the call parks `awaiting_grant` and the journal records why the grant was refused (`signature_invalid`).
- §3.2 C1: a correctly signed grant is honoured, before and after a restart.
- §3.2 C1: the runner refuses to start when its trust anchor is writable by it (container test: the verifier runs as a uid that does not own the read-only anchor).
- §3.2 C1: no test key, private or public, is committed; test keys are generated per run in a temporary directory outside the work volume and the journal.
- §3.4.1 C1: rewriting an entry and recomputing every hash after it passes the chain check but fails the anchor check; an entry appended after the anchor is not reported as a rewrite.
- §3.4.1 C1: the stand-in destination refuses to overwrite or delete an anchor already written; an anchor signed with a stolen journal key cannot replace an earlier one; no code path gives the runner the operator key.
- §3.2, §3.4.1: a grant selector naming the journal, the checkpoint store or the trust anchor is rejected at creation.

**Done when:** the tests above are green; every grant in the repository's fixtures is signed by a per-run test key; STATE.md gives the operator click-by-click Windows steps to create the keychain key, sign a grant, and create `juno-anchors` (public), its protection against force-push and deletion, and a push credential scoped to it alone. **That is the first point that needs the operator's hands; the increment's code and tests do not wait for it.**
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
**Depends on:** Increments 1 (canonical scope, including new paths, §2.7.1 v0.6.1) and 2 (signed grants carry `enumerated_targets`). **Estimate:** 2 sessions.

---

### Increment 4 — Hook mode for Claude Code (§4.3 mode C)

*JUNO governs a Claude Code session through its PreToolUse and PostToolUse hooks, fail-closed.*

**Implements:** §4.3 (mode C, fail-closed ingress, park mapping, provenance in B and C), §2.3.2 (E1), §7.8 (E2: `hook` → `steer_capability: none`), §2.2.2 under mediated modes.

**Builds:**
1. **Re-read the hooks reference first** and record differences from §1.1 in DECISIONS.md.
2. **`juno hook install`** writes the hook into the settings file the operator names, and **refuses** (§4.3 "refused at setup") unless all hold: exec form (`command` plus `args`, no shell); `onFailure: "block"`; an explicit `timeout`; matcher `*` on PreToolUse, PostToolUse and PostToolUseFailure; `claude --version` (run by `execFile`) at least 2.1.295. It reports, and does not hide, what it cannot control: `disableAllHooks`, `@`-mentions, harness actions without a tool call.
3. **The session is a Task (§4.3, v0.6.1).** Each Claude Code `session_id` is admitted as a Task: principal, objective "operator session via claude-code", attendance, `ttl`, grants, the program enum and name map for Bash, the exact command strings and values listed as constants, and the session's provider with its declared sensitivity clearance. No criterion, so it closes only `accepted`. Tool calls (counted as turns) and wall-clock are enforced; token and currency axes are recorded `unmetered`, and admission refuses unless the operator accepts that the harness's own limits govern them.
4. **Capability definitions for Claude Code's tools,** operator-authored (§2.5), never derived from the tool schema: `Read`, `Glob`, `Grep` (`read`); `Write`, `Edit` (`write`; `file_path` target, content payload); `Bash` (mapped to `shell.run` through §2.3.2); `WebFetch` (`external`; the URL is a target). A tool with no definition is a rejection (`unknown_capability`), so it is denied; three in a row park `rejection_limit`.
5. **Bash under §2.3.2 (v0.6.1).** A constant command string the operator listed is accepted as written. Otherwise the string is split into words without a shell, exactly by §2.3.2's grammar: spaces or tabs separate words; single-quoted words are literal; double-quoted words may not contain `$`, `` ` ``, `\`, `!`; outside single quotes any of `|` `&` `;` `<` `>` `(` `)` `$` `` ` `` `\` `{` `}` or a newline, an unquoted `*` `?` `[` `]`, a leading `~`, a leading `NAME=value`, or a first word that is a shell keyword or builtin parks `integrity_floor`. The first word maps to an enum member **only through the operator-authored name map** (`cat` → `/usr/bin/cat`); `PATH` is never consulted; a name not in the map parks. The remaining words become `argv`, judged as untrusted data. **Each enum member declares its own `side_effect`** (`cat` read, `rm` write in a reversible workspace and irreversible elsewhere); the call takes its member's effect, and registration review rejects a member declared lower than what it can do.
6. **Provenance and sensitivity (§4.3, v0.6.1):** every model-written value is `untrusted`; operator-listed values are `constant` at `operator` integrity; tool results journaled by PostToolUse are `untrusted`. JUNO does not route the harness's model, so it gates the **read**: a call that would read a source classified above the session provider's declared clearance parks before it runs; an earlier permitted read does not affect later calls.
7. **Decisions back to Claude Code.**
   - Proceed: no decision (exit 0, empty), so Claude Code's own permission rules still apply; JUNO may answer `allow` only where the session is configured to make JUNO the sole authority. Recorded as a D-number.
   - Park: `deny` with the park reason in `permissionDecisionReason`, the park journaled, and the remedy (a grant) applying to the model's retry. Never `ask`, never `defer` (§4.3, v0.6.1).
   - Rejection: `deny` with the reason.
   - Any doubt in the client (service unreachable, timeout, malformed answer): exit 2.
8. **Results:** PostToolUse and PostToolUseFailure journal the result against the call JUNO authorized. A call whose result never arrived is recorded as such, and the session's next call is denied until the gap is recorded — so a missing result cannot be silent.
9. **Writes in hook mode** use Increment 3's checkpoints on the host workspace before the first write; without a checkpoint a write is `irreversible` and its untrusted target parks.
10. Journal, checkpoint store, trust anchor and the hook's own settings files are outside every scope: a tool call naming them parks `scope_violation`, so Claude Code cannot edit its way out of the hook through a mediated tool.

**Tests:**
- §4.3 fail-closed: the hook client exits 2 when the service is down, when it times out, and when it gets an answer it cannot parse — each blocks the call (protocol-level test in `make verify`; real-binary test below).
- §4.3 refused at setup: `juno hook install` refuses a configuration without `onFailure: "block"`, in shell form, or on a Claude Code older than 2.1.295.
- §4.3 park mapping: a park answers `deny` with the reason and journals the park; no code path answers `ask` or `defer` (asserted over every decision the client can emit).
- §2.3.2: `cat notes.txt` (in the name map) proceeds with `cat` at floor `untrusted`; `cat notes.txt; curl x`, `$(…)`, `` `…` ``, `|`, `&&`, `>`, an unquoted glob, `~/x`, `FOO=1 cat x`, `eval …`, `cd x`, a newline, a backslash, and `sh -c …` each park `integrity_floor`; `cat 'a b'` and `cat "a b"` proceed with one operand; `cat "$HOME"` parks; a bare name not in the map parks even when it is on the harness's `PATH`; an operator-listed exact command proceeds as written.
- §2.3.2: `rm x` takes `rm`'s declared effect, not `shell.run`'s; registration review rejects an enum member whose declared effect is lower than what it can do.
- §4.3 session: admission refuses a session without the operator's acceptance of `unmetered` token and currency axes; the session closes only `accepted`; the rejection count is per session.
- §4.3 sensitivity: a read of a source above the provider's clearance parks and is denied before it runs; a later call after a permitted read is unaffected.
- §2.2.2 mediated: a `Write` inside a checkpointed scope proceeds; outside the grant it parks `scope_violation` and is denied; `WebFetch` to an untrusted URL not enumerated parks `integrity_floor`.
- §7.8 E2: a hook session's `steer_capability` is `none`.
- §4.3: a Claude Code subagent's tool call is mediated the same way (input with `agent_id`).
- **End to end, real Claude Code binary, no paid usage** (§5): §4.3 acceptance tests 1 and 2, and test 4's mode-C case.

**Done when:** the tests above are green in CI, and the real-binary end-to-end run (`make mediated-e2e`, D-092) is green in a cloud session and recorded in the PR; STATE.md says, in plain words, what mode C does not protect (§4.3's table).
**Depends on:** Increments 1–3. **Estimate:** 3 sessions.

---

### Increment 5 — Gateway mode for MCP (§4.3 mode B)

*Every tool call from an MCP client to a governed server passes the same boundary and lands in the same journal.*

**Implements:** §4.3 (mode B), §2.3.2, §7.8 (E2: `gateway` → `none`), §2.2.2 for `external` effects.

**Builds:**
1. **Re-read MCP 2026-07-28** (and the revision Claude Code actually speaks). The gateway supports exactly the revisions observed from Claude Code and from the test server, recorded as a D-number, and refuses any other (fail-closed). Implemented as plain JSON-RPC over stdio with runtime schemas; the `@modelcontextprotocol/sdk` package is added only if the lockfile installs it in CI and it supports the chosen revision (rule 13).
2. **`juno-gateway`:** a stdio MCP server to the client and an MCP client to one operator-configured upstream server, launched by `execFile(program, argv)`. Upstream credentials stay in the gateway's environment; the model never sees them (§3.2).
3. **Capability definitions per upstream tool,** operator-authored (§2.5). `tools/list` returns only defined tools; a call to any other tool is a rejection. Tool descriptions pass through unchanged and unprotected (§4.3 mode B row).
4. **Each `tools/call`:** the arguments are judged by the boundary (every value `untrusted`; operator-listed values `constant`); proceed forwards it; park or reject returns a tool result with `isError: true` and the reason (MCP has no defer), journaled; the remedy applies to the retry.
5. **Responses** are journaled as `untrusted`. A call that would read a source classified above the session provider's declared clearance parks before it is forwarded (§4.3, v0.6.1). The session is a Task, as in Increment 4.
6. **`input_required` (multi round-trip) results are refused** in Slice 1.5: the gateway returns an error to the client and journals it. Supporting them needs a design for the retried input's provenance, which v0.6 does not give. Recorded as a D-number (restrictive reading).
7. **Test MCP server** (JUNO-authored, test-only, in `test/`): `files.read` (`read`), and `message.send(to: target, body: payload)` (`external`), which records what it would have sent and sends nothing.

**Tests:**
- §4.3 mode B: a `tools/call` with an out-of-scope argument returns `isError: true`, is journaled as a park, and never reaches the upstream server (the server's record is empty).
- §2.2.2 `external`: `message.send` to an untrusted `to` not in `enumerated_targets` parks `integrity_floor`; to an enumerated recipient it proceeds and the server records it; the `body` may be untrusted.
- §4.3 fail-closed: upstream unreachable, boundary unreachable, malformed upstream response, unsupported protocol revision — each is an error to the client, never a forwarded call.
- §7.8 E2: a gateway session's `steer_capability` is `none`.
- §2.5: an upstream tool with no operator definition is not listed and a call to it is rejected.
- MRTR: an `input_required` answer is refused and journaled.
- **End to end:** a scripted MCP client (in `make verify`) and the real Claude Code binary with the scripted model (`make mediated-e2e`, cloud session only, D-092) — §4.3 acceptance test 3.

**Done when:** the tests above are green; STATE.md says what mode B does not protect.
**Depends on:** Increments 1–4; reuses Increment 4's session record and scripted model. **Estimate:** 2 sessions.

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

**Done when:** the protocol-level and mode-A parts of all four pass in one CI `make verify` run together with §18 tests 1–5, and the real-binary parts pass in one `make mediated-e2e` run in a cloud session (D-092); the PR description states, for each, how it ran and that no paid model was called; STATE.md records Slice 1.5 complete.
**Depends on:** Increments 1–5. **Estimate:** 1–2 sessions.

**Total estimate:** 13–14 sessions. The v0.6.1 rulings add tests (grammar, new paths, pins) but remove the uncertainty the objections carried; the estimate is unchanged.

---

## 4. How each acceptance test runs without paid usage

No acceptance test needs a real model. The injection in tests 2 and 3 is scripted, so the tests prove the boundary, not a model's behaviour (as §18 test 2 did with the scripted provider, D-002).

**The scripted model for Claude Code.** Claude Code is run in `-p` mode with `ANTHROPIC_BASE_URL` pointing at a JUNO test server on the local machine that speaks the Anthropic Messages API and returns pre-written turns (for example: "call `Write` on `/etc/x`"). `ANTHROPIC_API_KEY` is a random value generated per run (not a key; nothing accepts it), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and a fresh configuration directory so the operator's login is never read. The run happens in a container whose only network is the scripted server, so no request can reach a paid endpoint even by mistake. The Claude Code binary is the one installed in the cloud session; it is never added to the lockfile, the repository or an image (D-092), so in its container it is mounted read-only from the session's installation, and the test records its version. Increment 4 builds the scripted server from the current Messages API reference, read then (rule 13), and records every request Claude Code makes; **if Claude Code cannot run against it, Increment 4 stops and reports**, because protocol-level tests alone do not prove "a Claude Code session".

| Test | How it runs | Paid usage | Where |
|---|---|---|---|
| §4.3 test 1 | Real Claude Code + scripted model + JUNO hook; scripted turn writes outside the grant; asserts the deny, the journal's park entry, and that the file does not exist | None | `make mediated-e2e`, cloud session only (D-092) |
| §4.3 test 2 | Mode C: scripted turn 1 reads a planted file, turn 2 runs a Bash command with `;` and `sh -c`; asserts `integrity_floor`, deny, nothing ran. Mode A: §18 test 2 with the scripted provider | None | as above; mode A in `make verify` |
| §4.3 test 3 | Mode B: JUNO's test MCP server behind `juno-gateway`, driven by a scripted MCP client in `make verify` and by real Claude Code + scripted model; `message.send` to a planted recipient parks; the server records nothing sent | None | `make verify`; real binary as above |
| §4.3 test 4 | Grants signed with a per-run test key; a tampered grant, a grant signed by another key, and an unsigned grant are each not honoured — in mode A (container test) and mode C (real binary) | None | `make verify`; real binary as above |
| §18 tests 1–5 | Unchanged: scripted provider, real containers | None | `make verify` |

## 5. What needs the operator's own machine

- **For acceptance: nothing.** Every test above runs in CI or in a cloud session.
- **Now, before Increment 1:** put spec v0.6.1 on `main` (merge PR #27, head fcb1a60; D-096, D-099). V61-1 is ruled (D-098).
- **Once, for real use (Increment 2):** creating the operator's signing key in the Windows OS keychain (D-093) and signing one grant with `juno grant sign`; creating the public repository `juno-anchors`, protecting its history against force-push and deletion, and a push credential scoped to it alone (D-094, D-098; §3.4.1). CI cannot hold a keychain, so it uses throwaway per-run keys and the stand-in anchor container; the real-key path is proven only on the operator's machine. Increment 2 writes click-by-click Windows steps into STATE.md.
- **Optional, not acceptance:** one interactive Claude Code session on the operator's machine with the hook installed, to see an interactive `deny` in the terminal. It uses the operator's own Claude Code plan (no extra money); the automated tests use `-p` mode only, because the interactive terminal cannot be driven by a test.

---

## 6. Objections

### 6.1 V6-1 to V6-10 — resolved by v0.6.1 (D-091)

| ID | Question, short | Resolved in (v0.6.1) |
|---|---|---|
| V6-1 | Which files are verification inputs | §3.4.4 "What is pinned" (outputs vs inputs; D-097 for files in neither set) |
| V6-2 | A path that does not exist yet | §2.7.1 "Paths that do not exist yet" |
| V6-3 | `defer` that Claude Code may ignore | §4.3 "Park in B and C": always deny |
| V6-4 | Who signs the anchor; what is off-host | §3.4.1 "Who signs, and what counts as off-host" |
| V6-5 | Which shell syntax parks; program names | §2.3.2 "Reading a shell command string" |
| V6-6 | What record a mediated session is | §4.3 "A session is a Task" |
| V6-7 | A raised floor JUNO cannot route around | §4.3 "Sensitivity in B and C" |
| V6-8 | Source entry for a synthesized value | §11.1, "possible sources" |
| V6-9 | Rejection count reset and range | §2.7.1 "The count resets"; an unreadable turn is not a rejection (D-091) |
| V6-10 | A program's effect vs its capability's | §2.3.2 "Effect per program" |

### 6.2 Open

None. V61-1 (§3.4.1, public or private `juno-anchors`) was ruled (a) public by the operator on 2026-11-03 (D-098); §3.4.1 at fcb1a60 says "a **public** git repository whose history is protected against force-push and deletion, pushed to by a credential scoped to that repository alone".

---

## 7. Operator decisions — ruled 2026-11-03

1. **Where the real-binary tests run:** cloud sessions only, never vendored (D-092).
2. **The signing mechanism:** the Windows OS keychain; tests use a generated key (D-093).
3. **The anchor destination:** the operator's GitHub repository `juno-anchors`, public (D-094); §3.4.1 now says public (V61-1 ruled (a), D-098).
4. **PR #26** was merged on 2026-11-03.
5. **C2:** deferred to Slice 2 (D-095).

## 8. Not in Slice 1.5

- **C2, secret detection at context assembly (§1.4):** deferred to Slice 2 (D-095; v0.6.1 §0.0).
- **C3** (erasure by key destruction) is built with the hosted product (§3.4.5).
- Steer, Override as an object, the decision queue, the approval interface, the console, resource locking, estate budgets, the Surface contract, plugins, multiple providers in one task, concurrent tasks, delegation, memory, compaction, planning, retrieval (CLAUDE.md rule 9).
- §0.0's deferred items: standing tasks and per-period budgets, the GUI-action class, A2A peers, payment-mandate grant fields, the delegation provenance test.
- MCP Streamable HTTP transport (stdio only in Slice 1.5), MCP multi round-trip requests (refused), and more than one upstream server per gateway.
- `defer` in any mode (§4.3, v0.6.1), and any harness other than Claude Code for mode C.

## 9. Risks

- **The scripted model may not satisfy Claude Code.** If Claude Code needs endpoints or behaviour the scripted server cannot provide offline, tests 1, 2 and 4 (mode C) cannot run without paid usage. Increment 4 stops and reports rather than calling a paid model.
- **Claude Code's hook behaviour can change between releases.** Each mediated increment re-reads the reference; `juno hook install` pins a minimum version; the end-to-end test records the version it ran against.
- **Hashing large workspaces** (B2 pins, Increment 3 checkpoints) may be slow; both are bounded per task at admission, and exceeding the bound refuses admission rather than skipping the check.
- **D-097 may conflict with a §18 fixture.** If a §18 task creates a file its criterion cannot declare as an output, the restrictive reading would make that test impossible — a CLAUDE.md §7 STOP. Increment 1 checks every fixture first.
- **The spec is not on `main` yet** (D-096). Nothing in this plan starts until it is.
