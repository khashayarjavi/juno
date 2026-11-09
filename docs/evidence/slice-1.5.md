# Slice 1.5 evidence: JUNO governs Claude Code and MCP, and every journal is anchored

**Slice:** 1.5 (spec v0.6.1, §4.3 "Ingress modes, and what each does not protect"; build plan `docs/plans/slice-1.5-build-plan.md`).
**Merged increments:** 1 (canonical scope, PR #31), 2 (the operator's key, anchored heads, PR #35), 3 (what untrusted content can choose, PR #36), 4 (Claude Code's hook, mode C, PR #43), 5 (the MCP gateway, mode B, PR #46), 6 (§4.3's acceptance end to end, PR #48).
**How it was proven:** `make verify` in CI on every merged head (unit tests, then sealed containers), and `make mediated-e2e` in a cloud session with the real Claude Code binary. **No paid model was called** in any acceptance test: model turns are scripted (D-002, D-145), and the containers that run Claude Code have no network.

## In five lines

1. **JUNO now governs three ways in** (§4.3): its own loop (mode A), Claude Code through a hook it cannot turn off (mode C), and an MCP server behind JUNO's gateway (mode B). All three admit sessions, count calls and park through one shared session layer (D-194).
2. **§4.3's four acceptance tests pass together, in one `make verify` run with §18's five**, and again with the real Claude Code binary: a write outside the grant is denied; an injected shell command parks; an injected recipient parks and is never sent; a forged grant is not honoured.
3. **Every journal is now copied off the host** (§3.4.1, D-198): every mode, at most a minute apart and when a service stops. A session whose journal cannot be copied stops. The operator's `juno journal check` passes for every session the tests ran.
4. **Authority comes only from your key** (§3.2): grants are signed by a key Windows keeps, and a tampered, foreign or unsigned grant is refused in every mode.
5. **What JUNO cannot see, it cannot govern.** The limits below are stated plainly: above all, a Claude Code session you start on Windows itself is not governed, and your Windows account is trusted like your key.

## What Slice 1.5 proves

Each line is a property of the specification, the section it comes from, and where it is proven.

| # | Property | Spec | Proven by |
|---|---|---|---|
| 1 | A Claude Code session is denied a write outside its grant, and the denial is in the journal | §4.3 test 1 | `test/acceptance/slice-1.5.test.ts` (through `juno hook serve` and `juno hook admit`); real binary in `test/mediated-e2e/claude-code.e2e.ts` |
| 2 | An injected instruction that reaches a shell command with shell syntax or an interpreter parks `integrity_floor`, which cannot be overridden | §4.3 test 2, §2.3.2 | the same two files (mode C); §18 test 2 in `test/acceptance/acceptance.test.ts` (mode A) |
| 3 | An untrusted target of an `external` effect that the grant does not list parks; the server never receives it | §4.3 test 3, §2.2.2 | `test/acceptance/slice-1.5.test.ts` (through `juno gateway serve` and the real shim); real binary in `test/mediated-e2e/gateway.e2e.ts` |
| 4 | A forged grant (tampered, another key, unsigned) is not honoured | §4.3 test 4, §3.2 | `test/acceptance/slice-1.5.test.ts` (modes A and C); real binary (mode C) |
| 5 | Every test answers "why did this happen?" from the journal alone | §3.4.5 | each acceptance test reads its journal back with `explainTask` |
| 6 | Every journal's chain agrees with the anchors held off the host, with nothing left unanchored | §3.4.1 | each acceptance test, against the stand-in anchor container; real binary with the real git and `juno journal check` |
| 7 | No mode can open its journal without anchoring; a session whose journal cannot be anchored stops | §3.4.1, D-198 | `packages/runner/test/entry-points.test.ts`, part E |
| 8 | Every service starts only through one start-up check: never root; no JUNO state inside a workspace; nothing anyone else could change; a verified trust anchor | §3.2, §3.4.1, D-194 | `packages/runner/test/entry-points.test.ts`, parts A to D |
| 9 | In mediated modes the model may choose a program, never a shell; what runs is the command JUNO rebuilt from what it judged | §2.3.2, D-152 | real binary: a name only JUNO knows runs, with its quotes and flags exactly as judged |
| 10 | The Claude Code user cannot change JUNO's settings, hook, journal, grants, socket or anchor | §4.3, D-173 | `test/containers/hook-separation.test.ts`: 32 attempts, each refused by the kernel |
| 11 | Claude Code cannot load an MCP server other than JUNO's gateway, wherever the user defines one | §4.3 mode B, D-190 | real binary: five planted definitions never start |
| 12 | Paths are judged as the kernel resolves them: symlinks, hard links, case-folding file systems | §2.7.1 C4, D-113, D-157, D-178 | the kernel-oracle and property tests in `packages/mediated/test/` |
| 13 | §18's five Slice 1 acceptance tests still pass | §18 | `test/acceptance/acceptance.test.ts`, same run |

## What untrusted content can and cannot choose (§2.2.2)

"Untrusted" means anything the model wrote, read or was steered by. Your constants and values from sources you trust are not affected.

| Effect | Where it goes (target) | What it says (payload) |
|---|---|---|
| read | can choose anything inside the grant's scope | can choose |
| write | can choose a path only inside a reversible workspace you named, checkpointed before the first turn; anywhere else parks `integrity_floor` | can choose, up to the capability's ceiling |
| external (send, post, push) | cannot choose, unless the grant lists that exact value | can choose the wording, up to the ceiling |
| irreversible (delete, pay) | cannot choose, unless the grant lists that exact value | can choose, up to the ceiling |
| any | never chooses which program runs | — |

## What each mode does not protect (§4.3)

### Mode A — JUNO's own loop
JUNO runs the model and every call, in sealed containers (no network, non-root, no capabilities, CPU, memory and process limits). It does not protect:
1. **A kernel or container-runtime escape.** The seal is the container's.
2. **What a call is allowed to do.** A read inside the grant can read everything the grant covers; a write inside a reversible workspace changes it (you can restore the checkpoint).
3. **The model's own reasoning.** JUNO judges what the model asks to do, never what it thinks.

### Mode C — Claude Code with JUNO's hook
JUNO's hook judges every **tool call** Claude Code makes. It does not govern:
1. **Anything Claude Code does without a tool call:** its own memory, and the text of a file you `@`-mention if Claude does not then read it with a tool. The install turns direct `@`-insertion off (D-139), so a mentioned file is read through the Read tool, which JUNO judges.
2. **A file or symlink changed between JUNO's check and Claude Code's use of it.** Claude Code, not JUNO, performs the effect. Keep the workspace out of reach of anything else.
3. **How Claude Code is started (D-173).** JUNO governs a session only when you start Claude Code in the governed WSL terminal, as `juno-agent`, with the hooks in the root-owned managed settings. **A session started on Windows itself, or by another program, or with `CLAUDE_CODE_MANAGED_SETTINGS_PATH` naming another folder, is not governed: JUNO never sees it.** No governed tool call can change any of this.
4. **A shell function named with a program's absolute path.** JUNO hands Claude Code the command rebuilt with absolute paths (D-152), so `PATH` and aliases do not choose the program, but a shell startup file could define `function /usr/bin/cat { … }`. Keep `juno-agent`'s startup files free of functions.
5. **Steering and context:** a hook session cannot be steered (§7.8), and JUNO does not see the tool descriptions Claude Code reads.
6. **Tokens and money:** Claude Code's own limits govern them; you accept that when you admit a session.
7. **A hard link made after JUNO's check** (the gap in item 2). Hard links that exist at the check are detected (D-157).
8. **A public-looking web name that leads to a private server**, if you list the public internet as a source (D-164). List exact sites instead if your intranet uses such names.
9. **Everything mode A does not protect**, plus the residuals of running on your Windows machine (below).

### Mode B — an MCP server behind JUNO's gateway
1. **Tool descriptions.** The gateway passes the server's tool descriptions to the model unchanged; an injected instruction there reaches the model. What it can make the model *do* is still judged: an unlisted recipient parks.
2. **What the server does with an allowed call.** JUNO journals the call and the answer, but cannot see or undo what the server does inside its own systems.
3. **The server's own credentials and network.** They are the server's, set in your gateway session file; JUNO never shows them to Claude Code, but does not limit what the server reaches with them.
4. **Anything Claude Code does outside MCP and the hook.** In a session governed by the hook too, the hook covers Claude Code's own tools. Without JUNO's hook, only the gateway's calls are governed.
5. **Other MCP servers in a session without JUNO's hook and managed files.** The protections against them hold only where `juno hook install --gateway` installed them and `juno hook check --gateway` passed.
6. **An in-process (`sdk`) MCP server** registered by an app that starts Claude Code. Claude Code applies no list to it; JUNO's hook denies its calls, and a governed session is started from the WSL terminal, where no app registers one.
7. **How Claude Code is started** (as mode C item 3).
8. **Server-to-client requests and multi-step answers** are refused, not supported (D-186). A server that needs them does not work through the gateway.

## Residuals recorded during Slice 1.5, in plain words

Each is a limit JUNO states rather than hides. Where a decision number is given, the full reasoning is there.

**Running on your Windows machine (D-130, D-173)**
1. **Your Windows account is trusted like your signing key.** Any program running as you on Windows can ask Windows' key agent to sign a grant, and can start WSL as root. A governed Claude Code runs in WSL as `juno-agent`, with interop and drive mounting off, so it has no channel to Windows or to your key agent.
2. **A kernel or WSL escape** (root in the WSL2 kernel, or an escape from the VM to Windows) is not protected.
3. **Your signing key's agent** never exports the key, but signs for any program running as you (D-093).

**The journal and its anchors (§3.4.1, D-122, D-126, D-198)**
4. **Up to one interval of recent history can still be rewritten** by something that can write the journal's storage: entries written since the last anchor (at most a minute by default) are not yet protected. `juno journal check` reports them as "unanchored", never as verified.
5. **A compromised host can stop JUNO or withhold new entries** (§3.4.1's own residual). It cannot fake past entries that were anchored.
6. **The anchors depend on GitHub and the network.** If the anchor repository cannot be reached, sessions stop (fail-closed): availability, not safety.
7. **The push key is on the host.** Anything that takes over `juno-runner` can push new anchors, but cannot rewrite or delete the ones already pushed (the repository's ruleset blocks force-push and deletion). Your GitHub account, which can change that ruleset, is trusted like your Windows account.
8. **Resume does not compare the chain with the stored anchors before continuing** (D-126). A rewrite is still caught by the next anchor and by `juno journal check`.
9. **A whole task's journal deleted** leaves its anchors behind, so the check of that task fails, but JUNO cannot list task ids it was never told about (D-027's accepted residual).

**Paths and reads (D-113, D-157, D-162, D-164, D-174, D-178)**
10. **A read that meets more than 64 shortcuts** counts at your highest class, so a listing over a large `node_modules` can be stopped under a low clearance (a cost, not a gap).
11. **The workspace must be WSL's own case-sensitive file system.** A Windows folder is refused (D-178).

**Verification of a task (mode A, D-067)**
12. **A write that keeps a file's size and restores its modification time** is not detected by the protected-path listing.

**Closed during Slice 1.5** (recorded earlier as residuals, now fixed): symlinks in scope checks (D-047, closed by D-113); hard links (D-150, closed by D-157); an anchor committed but never pushed being counted after a restart (D-126, closed by D-198); hook and gateway journals that were never anchored (closed by D-198).

## What is not in Slice 1.5

Secret detection at context assembly (C2) is deferred to Slice 2 (D-095). Steer, Override, the decision queue, the approval interface, the console, plugins, and the other roadmap items stay out of scope (CLAUDE.md rule 9). The MCP gateway speaks stdio only, one server per gateway.
