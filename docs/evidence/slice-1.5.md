# Slice 1.5 evidence: JUNO governs Claude Code and MCP, and every journal is anchored

**Slice:** 1.5 (spec v0.6.1, §4.3 "Ingress modes, and what each does not protect"; build plan `docs/plans/slice-1.5-build-plan.md`).
**Merged increments:** 1 (canonical scope, PR #31), 2 (the operator's key, anchored heads, PR #35), 3 (what untrusted content can choose, PR #36), 4 (Claude Code's hook, mode C, PR #43), 5 (the MCP gateway, mode B, PR #46), 6 (§4.3's acceptance end to end, PR #48).
**How it was proven:** `make verify` in CI on every merged head (unit tests, then sealed containers), and `make mediated-e2e` in a cloud session with the real Claude Code binary. **No paid model was called** in any acceptance test: model turns are scripted (D-002, D-145), and the containers that run Claude Code have no network.

## In five lines

1. **JUNO now governs three ways in** (§4.3): its own loop (mode A), Claude Code through a hook it cannot turn off (mode C), and an MCP server behind JUNO's gateway (mode B). All three admit sessions, count calls and park through one shared session layer (D-194).
2. **§4.3's four acceptance tests pass together, in one `make verify` run with §18's five**, and again with the real Claude Code binary: a write outside the grant is denied; an injected shell command parks; an injected recipient parks and is never sent; a forged grant is not honoured.
3. **Every journal is now copied off the host** (§3.4.1, D-198): every mode, at most a minute apart and when a service stops. A session whose journal cannot be copied stops. The operator's `juno journal check` passes for every session the tests ran.
4. **Authority comes only from your key** (§3.2): grants are signed by a key Windows keeps. A tampered grant, one signed by another key and an unsigned one are each refused in modes A and C, and a tampered one in mode B.
5. **What JUNO cannot see, it cannot govern.** The limits below are stated plainly: above all, a Claude Code session you start on Windows itself is not governed, and your Windows account is trusted like your key.

## What Slice 1.5 proves

Each line is a property of the specification, the section it comes from, and where it is proven.

| # | Property | Spec | Proven by |
|---|---|---|---|
| 1 | A Claude Code session is denied a write outside its grant, and the denial is in the journal | §4.3 test 1 | `test/acceptance/slice-1.5.test.ts` (through `juno hook serve` and `juno hook admit`); real binary in `test/mediated-e2e/claude-code.e2e.ts` |
| 2 | An injected instruction that reaches a shell command with shell syntax or an interpreter parks `integrity_floor`, which cannot be overridden | §4.3 test 2, §2.3.2 | the same two files (mode C); §18 test 2 in `test/acceptance/acceptance.test.ts` (mode A) |
| 3 | An untrusted target of an `external` effect that the grant does not list parks; the server never receives it | §4.3 test 3, §2.2.2 | `test/acceptance/slice-1.5.test.ts` (through `juno gateway serve` and the real shim); real binary in `test/mediated-e2e/gateway.e2e.ts` |
| 4 | A forged grant (tampered, another key, unsigned) is not honoured | §4.3 test 4, §3.2 | `test/acceptance/slice-1.5.test.ts` (modes A and C, all three); real binary (mode C, all three); `packages/mediated/test/gateway-cli.test.ts` (mode B, tampered) |
| 5 | Every test answers "why did this happen?" from the journal alone | §3.4.5 | each acceptance test reads its journal back with `explainTask` |
| 6 | Every journal's chain agrees with the anchors held off the host, with nothing left unanchored | §3.4.1 | each acceptance test, against the stand-in anchor container; real binary with the real git and `juno journal check` |
| 7 | No mode can open its journal without anchoring; a session whose journal cannot be anchored stops | §3.4.1, D-198 | `packages/runner/test/entry-points.test.ts`, part E |
| 8 | Every service starts only through one start-up check: never root; no JUNO state inside a workspace; nothing anyone else could change; a verified trust anchor | §3.2, §3.4.1, D-194 | `packages/runner/test/entry-points.test.ts`, parts A to D |
| 9 | In mediated modes the model may choose a program, never a shell; what runs is the command JUNO rebuilt from what it judged | §2.3.2, D-152 | real binary: a name only JUNO knows runs, with its quotes and flags exactly as judged |
| 10 | The Claude Code user cannot change JUNO's settings, hook, journal, grants, socket or anchor | §4.3, D-173 | `test/containers/hook-separation.test.ts`: 32 attempts, each refused by the kernel |
| 11 | Claude Code cannot load an MCP server other than JUNO's gateway, wherever the user defines one | §4.3 mode B, D-190 | real binary: three planted definitions (the project's, the user's and the local scope's) never start |
| 12 | Paths are judged as the kernel resolves them: symlinks, hard links, case-folding file systems | §2.7.1 C4, D-113, D-157, D-178 | the kernel-oracle and property tests in `packages/mediated/test/` |
| 13 | §18's five Slice 1 acceptance tests still pass | §18 | `test/acceptance/acceptance.test.ts`, same run |
| 14 | A restart forgets nothing JUNO enforces: with restarts at any points, every mode reaches the same decisions and the same journal as with none (grant use, admitted ids, budgets, rejection counts, parks) | §3.2, §3.4.5, §5, D-201 | `packages/runner/test/restart.property.test.ts` (own loop, hook, gateway); shown failing before the fix in `docs/evidence/d201-restart/` |
| 15 | A service refuses to start when its journal was changed, cut, replaced, deleted or added to, when a stored payload is missing, when an anchor disagrees, when the anchor repository's history ever removed or changed an anchor, or when the anchors cannot be read | §3.4.1, §3.4.2, D-201, D-204 | `packages/runner/test/entry-points.test.ts`, part F, for every registered service; `packages/journal/test/git-sink.test.ts` (the history, with the real git) |
| 16 | After a power loss in the middle of a write, the service starts again: the incomplete last entry is dropped, a `recovered_truncation` entry records it, and every grant held or used by a session open at that moment is exhausted for good. Any other failure still refuses the start, and nothing is dropped | §3.4.1, §3.4.2, §3.2, D-206, D-207 | `packages/enforcement/test/recovery.test.ts` (the power lost before every file operation of a real append, and with half of each write on disk); `entry-points.test.ts` part G, for every registered service |
| 17 | After a manual recovery to a new journal, every grant signed before the recovery is refused: the journal records its recovery epoch, and a grant issued before it is refused at admission and at every call | §3.2, D-206, D-207 | `entry-points.test.ts` part G: every service's grant store; the gateway and the hook through the real commands (an old grant refused, a newly signed one accepted) |
| 18 | Which repository a journal is anchored to is not the runner's to say: it is read from root's own file, fetched afresh at every start over SSH with the pinned host key, and nothing in the runner's git or SSH settings can move it | §3.4.1, D-206, D-208, D-209 | `packages/journal/test/git-sink.test.ts` and `anchor-ssh.test.ts` (the real git, `ssh -G` and `ssh-keygen`; and the whole chain, the real git through the real `juno-anchor-ssh` to a stand-in ssh that carries the git protocol, as a session to GitHub would); `packages/mediated/test/preflight.test.ts` and `test/containers/hook-separation.test.ts` (`juno hook check`) |
| 19 | Replacing the journal, the local clone and the service's settings together does not make a service start as new; nor does replacing a folder above the journal with a symbolic link | §3.4.1, D-206, D-208, D-209 | `entry-points.test.ts` part G, for every registered service, with the real git: the journal, key and clone replaced; the settings pointed at a new journal, key and clone; the settings pointed at a pin of the runner's own. `packages/enforcement/test/pin-journal.test.ts`: a folder one or two levels above the journal replaced by a symbolic link |

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
JUNO runs the model and every call, in sealed containers (no network, non-root, no capabilities, CPU, memory and process limits). It does not protect (§4.3):
1. **A compromise of the host beyond what signing and anchoring cover** (§3.2, §3.4.1): a kernel or container-runtime escape, or something that takes over the runner. Signed grants mean it cannot fake permission; anchors mean it cannot quietly rewrite what was anchored.
2. **Code that reaches a program by a way other than the call's arguments** (§2.3.1): for example a program that reads instructions from a file it is allowed to read. JUNO judges which program runs and with which arguments, not what that program then does with its inputs.
Two more, not in §4.3's table but true of mode A:
3. **What a call is allowed to do.** A read inside the grant can read everything the grant covers; a write inside a reversible workspace changes it (you can restore the checkpoint).
4. **The model's own reasoning.** JUNO judges what the model asks to do, never what it thinks.

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
9. **Everything mode B does not protect** (and so everything mode A does not), plus the residuals of running on your Windows machine (below).

### Mode B — an MCP server behind JUNO's gateway
§4.3: everything mode A does not protect, plus the following.
1. **Context ownership and steering** (§7.8). The client, not JUNO, owns the conversation; a gateway session cannot be steered.
2. **Tool descriptions.** The gateway passes the server's tool descriptions to the model unchanged; an injected instruction there reaches the model. What it can make the model *do* is still judged: an unlisted recipient parks.
3. **What the server does with an allowed call.** JUNO journals the call and the answer, but cannot see or undo what the server does inside its own systems.
4. **The server's own credentials and network.** They are the server's, set in your gateway session file; JUNO never shows them to Claude Code, but does not limit what the server reaches with them.
5. **Anything Claude Code does outside MCP and the hook.** In a session governed by the hook too, the hook covers Claude Code's own tools. Without JUNO's hook, only the gateway's calls are governed.
6. **Other MCP servers in a session without JUNO's hook and managed files.** The protections against them hold only where `juno hook install --gateway` installed them and `juno hook check --gateway` passed.
7. **An in-process (`sdk`) MCP server** registered by an app that starts Claude Code. Claude Code applies no list to it; JUNO's hook denies its calls, and a governed session is started from the WSL terminal, where no app registers one.
8. **How Claude Code is started** (as mode C item 3).
9. **Server-to-client requests and multi-step answers** are refused, not supported (D-186). A server that needs them does not work through the gateway.

## Residuals recorded during Slice 1.5, in plain words

Each is a limit JUNO states rather than hides. Where a decision number is given, the full reasoning is there.

**Running on your Windows machine (D-130, D-173)**
1. **Your Windows account is trusted like your signing key.** Any program running as you on Windows can ask Windows' key agent to sign a grant, and can start WSL as root. A governed Claude Code runs in WSL as `juno-agent`, with interop and drive mounting off, so it has no channel to Windows or to your key agent.
2. **A kernel or WSL escape** (root in the WSL2 kernel, an escape from the VM to Windows, or an attack from the distribution on a Windows network service) is not protected.
3. **Your signing key's agent** never exports the key, but signs for any program running as you (D-093).
4. **The runner's "cannot write the trust anchor" check does not work on Windows itself** (D-124), where it refuses to start (fail-closed); the runner runs only in WSL.
5. **The trust anchor's check** looks at the file `/etc/juno/operator.pub` and its own folder, not the folders above it (D-116, D-194; a reviewer note on PR #35). Part E puts it in `/etc/juno`, root's, under root's `/etc`.

**The journal and its anchors (§3.4.1, D-122, D-126, D-198)**
6. **Up to one interval of recent history can still be rewritten** by something that can write the journal's storage: entries written since the last anchor (at most a minute by default) are not yet protected. `juno journal check` reports them as "unanchored", never as verified.
7. **A compromised host can stop JUNO or withhold new entries** (§3.4.1's own residual). It cannot fake past entries that were anchored.
8. **The anchors depend on GitHub and the network.** If the anchor repository cannot be reached, sessions stop (fail-closed): availability, not safety.
9. **The push key is on the host.** Anything that takes over `juno-runner` can push new anchors. It cannot take a pushed commit back out (the repository's ruleset blocks force-push and deletion), but it can push an ordinary commit that deletes or changes anchor files. JUNO reads the repository's whole history at every start and refuses a repository where that ever happened (D-204). Your GitHub account, which can change the ruleset, is trusted like your Windows account.
10. **A running service does not compare a task's chain with the stored anchors before each resume** (D-126). Every start does compare the whole journal with its anchors (D-201); a rewrite under a running service is caught by the next anchor, the next start and `juno journal check`.
11. **A record deleted from the journal is found at the next start** when it had been anchored: the journal's own record names every record, and the deleted one's anchors remain (D-202). One deleted before its first anchor is item 15.

**Paths and reads (D-113, D-157, D-162, D-164, D-174, D-178)**
12. **A read that meets more than 64 shortcuts** counts at your highest class, so a listing over a large `node_modules` can be stopped under a low clearance (a cost, not a gap).
13. **The workspace must be WSL's own case-sensitive file system.** A Windows folder is refused (D-178).

**Verification of a task (mode A, D-067)**
14. **A write that keeps a file's size and restores its modification time** is not detected by the protected-path listing.

**Restarts (D-201, D-202)**
15. **Entries newer than a record's last anchor** (at most one interval, or since `juno-anchors` was last reachable) can be changed or removed before a restart without JUNO noticing; that includes a record created and deleted within that time. This is §3.4.1's stated bound, and the reason the interval is short.
16. **A grant's use is counted per journal.** The hook service and the gateway each keep their own journal, so a grant used through both is counted by each.
17. **A refused start is repaired by hand, by you as root** (D-206): you add a new journal folder to `/etc/juno/anchors.json` with the time of the recovery. Every count starts again there, and every grant signed before that time is refused, so nothing issued before the recovery can be used twice (`docs/operator-setup.md`, "When something goes wrong"). Only a power loss in the middle of one write is repaired without you (property 16).
18. **No command revokes a grant in a running service.** You withdraw a grant by removing or re-signing its file and restarting the service.
19. **A gateway call in flight when the gateway is killed** is in the journal as a call with no result.
20. **Which anchor repository a service uses is what root's file `/etc/juno/anchors.json` says** (D-208). Whoever is root on the machine, or you by mistake, can still pin the wrong repository or the wrong host key; JUNO checks that the file is root's and well formed, not that it names the right thing. Comparing the fingerprint with GitHub's page is your step (guide, Part D step 7).
21. **Nothing stops two services being given one journal folder.** The guide gives each its own; two on one folder would both write the journal's own record.
22. *(Closed by D-206 and D-208; see below.)*
23. **`juno journal check` reads the anchor files of the copy you give it, not its history.** If an anchor file was removed by a commit, the check of that task fails for lack of anchors (fail-closed, D-126); it does not say who removed it.
24. *(Closed by D-206 and D-208; see below.)*

**Recovery and the pinned repository (D-206 to D-208)**
25. **What the pin closes, and what it does not.** JUNO's installed service, started on a journal, clone or settings that were replaced, refuses to start. That does not make the runner's account harmless: whoever takes over `juno-runner` can still stop the service, withhold entries (item 7), push extra anchors (item 9), or run a program of their own that is not JUNO at all. What they cannot do is make *JUNO* start as new and honour your grants again from zero. Your own check against a fresh copy from GitHub (guide, Part G step 7) remains the check that counts.
26. **A git command that runs longer than two minutes is ended and counts as a failure** (D-209), so an anchor repository that never answers refuses a start or stops sessions, as one that cannot be reached does.
26a. **The local clone is replaced at every start, not watched while the service runs.** Every command names the pinned address itself and runs with none of the runner's git or SSH settings, but a change made inside the clone's own folder while the service is running is only undone at the next start.
27. **A torn write is recognised by its shape:** the last line of exactly one record is incomplete, or complete with its head record not yet written, and everything before it verifies and agrees with the anchors. Someone who can write the journal could cut the last, not yet anchored, entry to look like that; that is inside item 15's bound, and it costs them every grant of every open session.
28. **"Open at the crash" errs on the strict side.** Every admitted session whose record shows no closing state counts as open, however long ago it last ran, so a torn write can exhaust grants of sessions you had finished with. A hook or gateway session records a closing state only when its time limit ends it.
29. **The recovery epoch is a time you type, and it decides which grants work.** A grant whose `issued_at` is earlier is refused, so the guide's dates are chosen to fit: the first journal's epoch two days ago, the first grant yesterday; after a recovery, the epoch and the new grants' `issued_at` the same time (D-209; tested against the guide's text). JUNO refuses grants signed before it and refuses a pin that later says another time for the same journal; it cannot know that the time you typed is the time of the recovery. The guide has you take it from `date`.
30. **A session or task id is used once per anchor repository, across recoveries too.** Its anchors are in `juno-anchors` for good, so the same id on a recovered journal cannot be anchored and does not run. Use new ids after a recovery.
31. **A pin that names a local folder instead of an SSH address** is accepted by the services (JUNO's own tests use one) and refused by `juno hook check`. Run the check (guide, Part G step 4).
32. **A journal written before 2026-11-13 records no recovery epoch** and is refused under a pin; it needs the manual recovery once.

**Closed during Slice 1.5** (recorded earlier as residuals, now fixed): the runner's clone of `juno-anchors` and its setting for where it pushes being on the host, so that a journal replaced together with them started as new (items 22 and 24, closed by D-206 and D-208: the repository and GitHub's host key are pinned in root's own file, every start fetches from there and compares, and only root can add a journal folder); a restarted hook or gateway service forgetting grant use and admitted sessions (D-200, closed by D-201 and D-202: every service verifies its journal against its anchors at start and rebuilds from it); two services of one runner pushing anchors to the same repository at once (D-199); symlinks in scope checks (D-047, closed by D-113); hard links (D-156, closed by D-157); an anchor committed but never pushed being counted after a restart (D-126, closed by D-198); hook and gateway journals that were never anchored (closed by D-198).

## What is not in Slice 1.5

Secret detection at context assembly (C2) is deferred to Slice 2 (D-095). Steer, Override, the decision queue, the approval interface, the console, plugins, and the other roadmap items stay out of scope (CLAUDE.md rule 9). The MCP gateway speaks stdio only, one server per gateway.
