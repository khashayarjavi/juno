# STATE

## Current increment
**Slice 1.5 — Increment 4: hook mode for Claude Code (§4.3 mode C)** (`docs/plans/slice-1.5-build-plan.md`, Increment 4; also §2.3.2 E1, §7.8 E2, D-131's Increment 4 directives). Branch `claude/vigilant-heisenberg-uko6on`, restarted from `main` 5951e57 after PR #36 merged. Spec v0.6.1. No objection open.

Status: **building; not done.**
- **Step 1 done** (D-139): the hooks reference was re-read on 2026-11-05.
  - Plan §1.1 still holds point by point.
  - New: `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` routes `@`-mentions through the file tools, so the install will require it, and the minimum Claude Code version becomes 2.1.299.
  - JUNO never emits `updatedInput` or `updatedToolOutput`.
- The cloud session has Claude Code 2.1.318.
- **Built and green (949 unit tests, 2026-11-05):**
  1. the §2.3.2 command-string reader (D-140);
  2. `packages/mediated`: the session as a Task, tool definitions, PreToolUse decisions (deny or nothing), PostToolUse results, Bash via the name map with the untrusted program floor, the path map, the read gate, and checkpoints at admission (D-141). 25 protocol-level tests cover the plan's list.
- **Also built (969 unit tests green):**
  3. the socket service and the `juno-hook` client, which exits 2 on any doubt (D-142);
  4. `juno hook install` and its setup refusals (D-143);
  5. D-073's network guard admits the hook's Unix-socket files only, with a new check that they name no host, port or URL (D-144; flagged for the reviewer).
- **`make mediated-e2e`: GREEN on 2026-11-05 with the real Claude Code 2.1.318, 4 of 4, no paid model, no network** (D-145). It covers §4.3 tests 1, 2 and 4 in mode C.
- **Left:**
  - the full `make verify`;
  - the PR and the gate.

### What mode C does not protect (§4.3; Increment 4's done-when)
In plain words, JUNO's hook governs every **tool call** Claude Code makes. It does not govern:
1. **Anything Claude Code does without a tool call:** its own memory, and the content of a file you `@`-mention if Claude does not then read it with a tool. JUNO's install turns direct `@`-insertion off (D-139), so a mentioned file is read through the Read tool, which JUNO judges.
2. **A file or symlink changed between JUNO's check and Claude Code's use of it.** Claude Code, not JUNO, performs the effect, so D-121's writer protection does not apply in this mode. Keep the workspace out of reach of anything else.
3. **A configuration that bypasses the hook:** a run started with `--settings '{"disableAllHooks": true}'`, settings of higher precedence that turn hooks off, or managed settings that allow only managed hooks. JUNO refuses to install into project or local settings, and the install prints these limits.
4. **Context ownership and steering** (§7.8: a hook session's `steer_capability` is `none`), and the text of tool descriptions Claude Code reads.
5. **Tokens and money:** Claude Code's own limits govern them; you accept that when a session is admitted (`unmetered`).
6. **Everything mode A does not protect**, plus D-130's residuals: a kernel or WSL escape, and a compromised Windows account. Claude Code runs as your Windows user, which can ask your agent to sign.

### Increment 4 design (2026-11-05; each choice becomes a D-number when built)
- **Package `packages/mediated`**, shared with Increment 5's gateway. It uses the same `EnforcementBoundary`, `GrantStore` and `JournalWriter` as mode A.
- **Session as a Task (§4.3 V6-6).**
  - `admitSession` takes:
    - the principal, attendance, `ttl`;
    - the grants;
    - the tool-call budget (`turns`) and wall clock;
    - `unmetered_accepted: true`, without which admission is refused;
    - the session provider's declared sensitivity clearance;
    - the operator's constants: exact command strings and values;
    - the Bash name map.
  - The Task id is `session-<session_id>`. `closure_mode` is `accepted`, `steer_capability` is `none` (§7.8 E2), and the strategy is `hook`.
- **Paths.** The operator's workspace root (WSL path, plus its Windows `\\wsl.localhost\…` form) maps onto `/work`. Any other path has no mapping, so it is outside every scope. Canonical resolution uses the same resolver script on the host (`HostPathResolver`, moved into `packages/enforcement`).
- **Tools → capabilities** (operator-authored typed entries, D-134; harness adapters plan a no-op invocation that is never performed, so they pass §2.4):
  - `Read`, `Glob`, `Grep`: `read`;
  - `Write`, `Edit`: `write`, with `file_path` the target and content and strings the payload;
  - `WebFetch`: `external`, `url` the target;
  - `Bash` → `cc.bash`: a `shell.run`-shaped entry whose enum is the name map's programs and whose program floor is `untrusted` (§2.3.2, mediated only). Registration review requires every member to pass the interpreter test, and D-131 bars signing or launching programs.
  - A Glob/Grep pattern with `..` or a leading `/` or `~` is `malformed_call`.
  - Any other tool is `unknown_capability`, which denies; three in a row park `rejection_limit`.
- **PreToolUse**, in order:
  1. no admitted session → deny;
  2. a previous call with no result → the gap is journalled and this call is denied;
  3. a budget or TTL exceeded → deny (TTL fails the session);
  4. a read of a source above the clearance → park `sensitivity_ceiling`, deny (§4.3 V6-7);
  5. Bash → `readCommandString`; a constant command proceeds as written;
  6. the boundary decides.

  Proceed → **no decision** (exit 0, empty: Claude Code's own rules still apply). Park → `deny` with the reason, and the park journalled with `overridable` as in mode A. Reject → `deny`. Never `ask`, `defer`, `allow`, `updatedInput` or `updatedToolOutput`.
- **PostToolUse / PostToolUseFailure.** The result is journalled against the call JUNO authorized (by `tool_use_id`), as `untrusted` content raising the session floor by the source read. A result with no authorized call is journalled as such.
- **Service and client.** A Unix-socket service (one JSON line in, one out). The client `juno-hook` (node builtins only) reads the hook input from stdin, asks the service with a timeout, and prints Claude Code's `deny` JSON or nothing. On **any** doubt (no service, timeout, malformed answer) it exits 2.
- **`juno hook install`** writes `PreToolUse`, `PostToolUse` and `PostToolUseFailure` with matcher `*`, exec form, `onFailure: "block"` and an explicit `timeout`, plus `env.CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`, into the user (or managed) settings file. It refuses:
  - project and local settings files;
  - Claude Code older than 2.1.299 (`claude --version` by `execFile`);
  - shell form, a missing `onFailure: "block"`, or a missing timeout.

  It prints what it cannot control.
- **E2E (`make mediated-e2e`, cloud only, D-092):** a scripted Messages API server, and real `claude -p` in a container whose only network is that server.

**Carried into Increment 4 and later (from PR #36's review, not defects):**
- **Enumerated targets are matched as typed, not on the canonical path (D-133).** An enumerated path that is already a symlink would match while the effect lands on its target. Scope is still judged on the canonical path. To settle before any `irreversible` path capability is registered; restrictive option: match enumerated path values on their canonical form.
- **`resource_scope` limits path fields only.** A string target such as a recipient is limited by `enumerated_targets` alone. To settle in Increment 5, before the first real `external` capability (`message.send`).
- **Test gap to fill:** for `irreversible`, the bound-not-untrusted case is tested only for `external`.

## Previous increment (Slice 1.5 Increment 3, merged as PR #36)
**Slice 1.5 — Increment 3: effects under untrusted influence** (`docs/plans/slice-1.5-build-plan.md`, Increment 3; spec §2.2.2 A1, §2.7.1 "Effects", §3.2 `enumerated_targets`, §2.4; D-121). Branch `claude/vigilant-heisenberg-uko6on`, restarted from `main` d7e7ec3 after PR #35 merged. Spec v0.6.1. No objection open.

Status: **built; going through the §7 gate.** `make verify: GREEN` locally on 2026-11-05 (885 unit, 72 container, §18 acceptance included).
- **Built:**
  - target/payload fields (D-132);
  - `enumerated_targets` (D-133);
  - typed registry entries (D-134);
  - step 4's effect table (D-135);
  - reversible workspaces with checkpoints taken before the first turn (D-136);
  - `fs.file.write` with a writer that never follows a symlink in any component (D-121, D-137);
  - `juno checkpoint restore` (D-138).
- **Done-when:**
  - the plan's tests are green (see the PR);
  - the registry has exactly one new capability, `fs.file.write`;
  - the per-class table is below.

### What untrusted content can and cannot choose (§2.2.2; Increment 3's done-when)
"Untrusted" means anything the model wrote, read or was steered by: a synthesized value, or a value bound to an `untrusted` entry, or one with no established integrity. Operator constants and values bound to entries that are not `untrusted` are not affected by this table.

| Effect class | In a **target** field (what is affected, or where it goes) | In a **payload** field (content) |
|---|---|---|
| `read` (e.g. `shell.run` with `cat`) | **Can choose** anything inside the grant's scope (canonical paths, §2.7.1). | Can choose it. |
| `write` (e.g. `fs.file.write`) | **Can choose** a path only inside a reversible workspace: one the operator named at admission, checkpointed before the first turn, restorable by `juno checkpoint restore`. **Cannot choose** anywhere else; that parks `integrity_floor` (not overridable). | Can choose it, up to the capability's sensitivity ceiling. |
| `external` (send, post, push) | **Cannot choose** it unless the grant enumerates that exact value for that field. Otherwise it parks `integrity_floor` (not overridable). | Can choose the wording, up to the capability's sensitivity ceiling. |
| `irreversible` (delete, pay) | **Cannot choose** it unless the grant enumerates that exact value for that field. Otherwise it parks `integrity_floor` (not overridable). | Can choose it, up to the ceiling. |
| Any (§2.3, unchanged) | **Never chooses which program runs**: instruction fields are judged by integrity floors, and typed capabilities like `fs.file.write` have none. | n/a |

Every write, at the moment it happens, refuses to follow a symlink in any part of its path, whatever the boundary saw earlier (D-121). A component swapped for a symlink in between makes the write fail, and the journal records why.

### Increment 3 design (2026-11-04; each choice to be recorded as a D-number when built)
- **Target and payload (§2.2.2).** An interface field gets `data_effect: "target" | "payload"`, meaningful for `data` fields only. An undeclared `data` field parses as `target` (fail-closed). Declaring it on an `instruction` field is refused. `shell.run`'s `argv` and `cwd` are declared `target`.
- **`enumerated_targets` on Grant (§3.2).** An optional list of `{ field, value }`: an exact scalar value for one named target field.
  - Absent means none. It is not given a default, so grants signed before this increment keep their canonical bytes and their signatures.
  - Restrictive reading: an enumerated value counts only for the field it names, and it still has to be inside `resource_scope`.
- **Step 4 effects (§2.7.1 "Effects").** After the scope check, each in-scope candidate is judged by §2.2.2's table. "Untrusted" means `untrusted` or unestablished integrity, the same reading as D-109/D-119.
  - `read`: nothing changes.
  - `write`: an untrusted target is permitted only when its canonical path lies in one of the task's reversible workspaces (checkpointed); otherwise the call is judged as `irreversible`.
  - `external` and `irreversible`: an untrusted target must be enumerated by that grant for that field.
  - When no candidate is left, the call parks `integrity_floor` (not overridable, §8.3), with the offending targets listed. Payloads are judged only by step 5.
- **Reversible workspaces (§2.2.2).** The operator declares them at admission: Task `reversible_workspaces`, a list of path prefixes, default empty, each inside one of the task's grant scopes.
  - The runner checkpoints each one before the task's first turn (so before its first effect), into a content-addressed checkpoint store outside every mount and selector, and journals a `checkpoint` record: the manifest of paths, types, modes, sha256 and symlink targets.
  - The content is read in the workload by an operator-fixed node script that never follows a symlink.
  - Bounds: 2,000 entries and 8 MiB. A larger workspace fails the task, never skips.
  - A scope with no checkpoint is not reversible.
  - `juno checkpoint restore <task> <checkpoint>` is the operator action. It writes the manifest back in a one-off workload container (removing what the manifest lacks), re-lists the scope, compares it with the manifest, and journals the restore and its result.
- **Registry: typed entries.** `program_field`, `argv_field` and `cwd_field` become all-or-none. An entry without them is a typed capability, which may have no `instruction` field (restrictive), so it has no promotion and no flag surface. Scope paths are its `path`-typed data fields.
- **`fs.file.write(path: data/target path, content: data/payload string)`, `side_effect: write`.** Its adapter runs `node /opt/juno/fs-write.mjs -- <path> <content>` in a fresh workload container, with the path and the content as separate argv elements. Content is limited to 65,536 bytes; above that the adapter refuses and the call is rejected `malformed_call`.
  - **D-121:** the writer walks the path from `/work` one component at a time through `/proc/self/fd/<dirfd>/<name>` with `O_NOFOLLOW | O_DIRECTORY`, so no symlink in any component is ever followed, whatever the boundary saw.
  - It creates missing directories with `mkdir` on the same fd-relative path and opens the file with `O_NOFOLLOW | O_CREAT | O_TRUNC`.
  - On refusal it exits non-zero with the reason on stderr, and the runner journals it in the `capability_result`.
  - Test: a resolver wrapper swaps a component for a symlink after the real resolution and before the boundary's verdict and the write. The write must fail, nothing outside the scope may change, and the journal records why.
- **Test-only `external` and `irreversible` capabilities** (unit tests only, not in the registry) prove the table and `enumerated_targets`.

## Previous increment (Slice 1.5 Increment 2, merged as PR #35)
**Slice 1.5 — Increment 2: signed grants and an anchored journal head (C1)** (`docs/plans/slice-1.5-build-plan.md`, Increment 2). Branch `claude/vigilant-heisenberg-uko6on`, the only branch this session may push. It carries PR #34's commits unchanged (from `claude/compassionate-noether-9s2sf2`, head 889c5be, which carried PR #33's), so the record continues in a new PR from it; PR #34 is superseded. Spec v0.6.1. No objection to the spec open.

Status: **D-129's STOP is lifted by your ruling (e) (D-130). The WSL2 plan section (§2a) and Part E below are written to it; the rootless proof is built (D-131); review round 3 is next.** Increment 2's own code is unchanged since PR #33's round 2.
- **Your ruling on D-129, recorded as D-130:** option (e), rootless containers with Windows interop disabled; the runner as an unprivileged user with no sudo and no root-granting group; `/etc/wsl.conf` root-only; your Windows account is a trust root, like the signing key.
- **What the sources say (read 2026-11-04; D-130 has quotes and hashes):**
  - Docker's rootless docs: rootless limits (`--cpus`, `--memory`, `--pids-limit`) work only with **cgroup v2 and systemd**; otherwise they are silently ignored. CPU needs a `Delegate=` drop-in.
  - Microsoft's WSL settings page: systemd is supported on WSL2 (`[boot] systemd=true`), and WSL2 mounts **cgroup v2 by default**. So WSL2 can meet Docker's conditions. No vendor page names "rootless Docker on WSL2" directly; Part E's last check proves it on your machine.
  - **`wsl.exe --exec` still works with interop off.** Microsoft describes interop as launching Windows programs from Linux only. WSL's own source shows Windows-started Linux processes are created regardless, and the Linux-to-Windows channel is opened only when interop is on.
- **Autopilot rulings (D-131), each the restrictive reading:**
  - "no root-granting group" means **no supplementary group at all**;
  - Windows **drive automount is off** too, or the runner could plant files in your Windows profile without interop;
  - the rootful Docker service is disabled;
  - the D-025 limits must be **enforced**, so the rootless suite first checks cgroup v2, the systemd driver, and cpu/memory/pids delegation;
  - Increment 4 directives: the runner refuses to start when the cgroup driver is `none`; the Bash name map may not list a program that can sign or start programs (`ssh-keygen`, `ssh-add`, `wsl`, `powershell`, `git`, any interpreter, …).
- **Residuals, stated (D-130; plan §2a):**
  1. **A kernel or WSL escape:** root in the WSL2 kernel, an escape from the VM to Windows, or an attack from the distribution on a Windows network service.
  2. **A compromised Windows account:** any program running as you can ask your agent to sign. That includes Claude Code itself and whatever it does outside JUNO's hook (`@`-mentions, `disableAllHooks`, harness actions with no tool call), and `wsl --user root`.
- **Proof built (D-131):** `make verify-rootless`, run as the unprivileged user `juno-runner` under rootless Docker. `scripts/rootless/setup-root.sh` and `run-verify.sh` set it up and run it. CI job `verify-rootless` runs it on ubuntu-24.04 (systemd, cgroup v2).
  - First, `test/rootless/runner-user.test.ts` checks that the user:
    - is not root;
    - is in no supplementary group;
    - cannot use sudo or su;
    - cannot write, replace or remove `/etc/wsl.conf` or write `/etc`;
    - cannot reach the rootful Docker socket.

    It also checks that the daemon is rootless, on cgroup v2 with the systemd driver, with cpu, memory and pids delegated.
  - Then the whole container suite (69 tests, including the seal and D-025 limit tests) runs under the rootless daemon.
- **Proof in this cloud session (2026-11-04):** see "Rootless runs" below.
- **Review rounds 1 and 2 (PR #33), recorded earlier:**
  - **Review round 1 (head 495b931; fresh subagent, P2 verbatim): DO NOT MERGE.** CI on 495b931 passed (run 41771539413). Checks 2, 3, 4 and 6 PASS. Fixed (D-125):
    - the plan's "no test key is committed" test was missing (now `test/lint/no-keys.test.ts`);
    - admission and resume accepted an unsigned grant (it could never run a call, but §3.2 says it does not exist);
    - the runner's own start-up did not yet load the trust anchor.
  - **Review round 2 (head 809714e; fresh subagent, P2 verbatim): DO NOT MERGE.** CI on 809714e passed (run 41773133614). Checks 1, 2, 3, 4 and 6 PASS. One FAIL, fixed (D-126): `juno journal check` said ok when it found no anchor for a task (fail-open). Also fixed, from the reviewer's notes: the restart test now exercises the runner's own path. Two residuals are recorded in D-126, not changed.
- **Operator rulings of 2026-11-04, recorded:**
  - D-118: D-100 confirmed.
  - D-119: D-109 stands.
  - D-120: D-112 hardening, built. Resolver paths now follow a `--`. A container test plants `-c` and `--help` in the scope; the pins are computed and the task closes verified.
  - D-121: Increment 3 must close the gap between resolving a path and writing to it.
  - D-127: three review rounds (CLAUDE.md §7).
  - D-128: Windows steps corrected; Part D deferred.
  - D-129: the STOP, now lifted by D-130.
- **Autopilot rulings:** D-123 (four readings of §3.4.1); D-131 (readings of D-130).
- **Done-when check:**
  - the plan's tests are green;
  - every fixture grant is signed by a per-run test key (D-115);
  - the operator's steps are below, now including Part E.

### Rootless runs (D-131)
- **This cloud VM** (cgroup v1, no systemd), 2026-11-04: `scripts/rootless/setup-root.sh --preload-images`, then `run-verify.sh`. Result: **10 of 12** rootless preflight tests pass.
  - **Pass:** not root; no supplementary group; no sudo; no su; `/etc/wsl.conf` stand-in disables interop, Windows paths and automount; it and `/etc` are root's; it cannot be written, replaced or removed; the session switch cannot be flipped; the daemon is rootless on the user's own socket; the rootful socket is unreachable.
  - **Fail, as designed:** "runs on cgroup v2 with the systemd cgroup driver" (`expected '1 none' to be '2 systemd'`), and "has the cpu, memory and pids controllers delegated". On this VM rootless Docker reports cgroup driver `none` and would ignore the limits. **This VM cannot show the D-025 limits rootless; CI and your WSL2 can.**
  - **Container suite under the rootless daemon on this VM** (as `juno-runner`, `make containers`): **64 of 69 pass**. Every seal test passes rootless here: no network, non-root (uid 65532), no capabilities, the journal and anchor volumes unreachable, and no Docker socket in any container.
  - **The 5 failures are exactly the D-025 limits:**
    - memory: not OOM-killed at 1024 MiB;
    - pids: `pids.max` absent, so there is no EAGAIN at 128 (two tests);
    - CPU: 2.94 CPUs used against a limit of 1;
    - `registry.test.ts`: `pids.max` is not `128`.

    That is Docker's documented cgroup v1 behaviour, not a JUNO defect. **The rootless limits are proven or refuted by CI job `verify-rootless`.** If it fails on a limit there, that is the STOP the ruling names.
- **CI `verify-rootless` (ubuntu-24.04, run 41887176162 on 8057fe2): GREEN.**
  - `rootless daemon 29.9.2: cgroup v2, driver systemd`, with cpuset, cpu, io, memory and pids delegated to `juno-runner`.
  - Preflight **12 of 12**.
  - Container suite **69 of 69** under the rootless daemon, including every seal test and **every D-025 limit**: the memory OOM-kill at 1024 MiB, EAGAIN at 128 processes, and one CPU.
  - **No limit is unenforceable rootless, so the ruling's STOP does not fire.** `verify` passed in the same run.
  - Four CI-image problems were fixed in the setup script on the way (commits e097c0c to 8057fe2, D-131):
    - the user manager must not be restarted after the delegation drop-in (its first start already has it);
    - the image's `/etc/environment` gives every user the CI user's `XDG_RUNTIME_DIR` and `XDG_CONFIG_HOME`, so the runner's manager gets its own;
    - the image's `/home` carries a default ACL naming the CI user, which no rootless namespace maps, so the runner's home and the repository copy carry no ACL;
    - diagnostics are printed on failure.

### Operator steps (Windows) — the first point that needs your hands
Nothing in the increment's code or tests waits for these: CI and the cloud sessions use throwaway keys and the stand-in anchor container. These steps set up real use. Do them in order. Each part ends with a check that tells you it worked. Commands go in **PowerShell**: press the Windows key, type `PowerShell`, and press Enter. When a step says *as administrator*, right-click "Windows PowerShell" and choose **Run as administrator** instead.

**Part A — prerequisites (once).**
1. Check that the OpenSSH client is present. In PowerShell, type `Get-Command ssh-keygen` and press Enter. If you see a path ending in `ssh-keygen.exe`, continue. If you see an error, open **Settings → System → Optional features → View features** (on Windows 10: **Settings → Apps → Optional features → Add a feature**), search for **OpenSSH Client**, tick it, and click **Install**.
2. Check that Git and Node.js 22 are installed: `git --version` and `node --version` should print versions, and node's should start with `v22`. If not, install Git for Windows from https://git-scm.com/download/win and Node.js 22 LTS from https://nodejs.org, accepting the defaults.
3. Get JUNO's command once this increment is merged:
   ```
   git clone https://github.com/khashayarjavi/juno.git $env:USERPROFILE\juno
   cd $env:USERPROFILE\juno
   npm ci
   npx tsc -p tsconfig.build.json
   ```

**Part B — your grant-signing key, kept by Windows (the OS keychain, D-093, D-124).**
1. *As administrator*, turn on the key agent (it is off by default):
   ```
   Get-Service ssh-agent | Set-Service -StartupType Automatic
   Start-Service ssh-agent
   Get-Service ssh-agent
   ```
   Check: the last line says **Running**. Close the administrator window.
2. In a normal PowerShell window, create the key:
   ```
   ssh-keygen -t ed25519 -C "juno-grant-signing" -f $env:USERPROFILE\.ssh\juno_grant
   ```
   When asked for a passphrase, type a strong one twice (it does not echo).
3. Hand the key to the agent: `ssh-add $env:USERPROFILE\.ssh\juno_grant`, then type the passphrase. Check: `ssh-add -l` lists a line ending in `juno-grant-signing (ED25519)`.
4. Back up the private key file `C:\Users\<you>\.ssh\juno_grant` (the one **without** `.pub`) to somewhere off this computer that you control, for example a USB stick kept safe or your password manager's file attachment. Then delete it from the computer: `Remove-Item $env:USERPROFILE\.ssh\juno_grant`. From now on Windows' agent holds the key: the agent never exports the key, but any program running as your Windows user can ask it to sign (D-093).
5. **Keep** `juno_grant.pub`. It is your public key, the trust anchor JUNO checks every grant against. It is not secret.

**Part C — sign a grant, and check it.**
1. In `$env:USERPROFILE\juno`:
   ```
   node dist\runner\src\juno.js grant sign --ssh-key $env:USERPROFILE\.ssh\juno_grant.pub docs\examples\grant.example.json --out $env:USERPROFILE\signed-grant.json
   ```
   Check: it prints `signed grant written to ...`. If it asks for nothing and fails with "agent", repeat Part B step 3.
2. ```
   node dist\runner\src\juno.js grant verify --anchor $env:USERPROFILE\.ssh\juno_grant.pub $env:USERPROFILE\signed-grant.json
   ```
   Check: it prints `valid`.
3. Optional check that forgery fails: open `signed-grant.json` in Notepad, change `"max_invocations": 10` to `11`, save, and run step 2 again. It must print `invalid`.
4. Paste the single line inside `juno_grant.pub` (it starts with `ssh-ed25519`) into your next message to the agent, so a later session can configure it as the trust anchor. It is public; do not paste anything else.

**Part D — the public anchor repository `juno-anchors` (D-094, D-098; §3.4.1). Deferred (D-128): do it only when a real runner on your machine will use the token (the runner runs in WSL2: D-130, Part E).**
1. On https://github.com, click **+** (top right) → **New repository**. Repository name: `juno-anchors`. Choose **Public**. Tick **Add a README file**. Click **Create repository**.
2. Protect its history. On the repository page, click **Settings**. In the left sidebar, under "Code, planning, and automation", click **Rules → Rulesets**. Click **New ruleset → New branch ruleset**.
   - Ruleset name: `protect-history`.
   - Enforcement status: **Active**.
   - Leave the bypass list empty.
   - Under "Target branches", click **Add a target → Include default branch**.
   - Under "Branch protections", make sure **Restrict deletions** and **Block force pushes** are both ticked.
   - Click **Create**.
3. Check the protection without touching the repository: go back to **Settings → Rules → Rulesets** and click `protect-history`. Check: it shows **Active**, the target is the default branch, and **Restrict deletions** and **Block force pushes** are both ticked. Do not try to delete or force-push anything to test it.
4. A push key for this one repository. Click your profile picture (top right) → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Token name: `juno-anchors-push`.
   - Expiration: 90 days.
   - Resource owner: you.
   - Repository access: **Only select repositories**, and pick `juno-anchors` only.
   - Permissions: under the repository permissions, set **Contents** to **Read and write**.
   - Click **Generate token** and copy it. You see it only once. Where it goes is set when the runner's machine is settled (D-129); until then, do not store it anywhere.
5. Tell the agent: "Part D done". Never paste the token, the private key or the passphrase anywhere.

**Now:** tell the agent "Parts A–C done", plus the `.pub` line (Part C step 4). Part E follows once this increment is merged.

**Part E — WSL2 for the runner (D-130, D-131; plan §2a).** Do this after Parts A–C and after this increment is merged. It takes about 45 minutes.
- Boxes marked **PowerShell** go in PowerShell (*as administrator* only where it says so).
- Boxes marked **Ubuntu** go in the Ubuntu window. Paste each box whole and press Enter.
- If a check does not show what it says, stop and send the agent the last 15 lines on screen.
- Sources, read 2026-11-04: Microsoft's WSL settings and file-system pages, and Docker's "Install Docker Engine on Ubuntu" and "Rootless mode" pages (D-130).

1. **Install Ubuntu 24.04 in WSL2.** **PowerShell, as administrator:**
   ```
   wsl --update
   wsl --list --online
   ```
   Check: the list includes `Ubuntu-24.04`. Then:
   ```
   wsl --install -d Ubuntu-24.04
   ```
   An Ubuntu window opens and asks for a new UNIX user name and password. Choose your own; this is your **admin** user, with sudo. JUNO never runs as it. Check, in **PowerShell**: `wsl --list --verbose` shows `Ubuntu-24.04` with `VERSION` `2`.
2. **Turn on systemd** (Docker's rootless mode needs it). **Ubuntu:**
   ```
   printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
   ```
   Then, in **PowerShell**: `wsl --shutdown`. Wait 10 seconds and open Ubuntu again (Start menu → **Ubuntu 24.04**). Check, in **Ubuntu**:
   - `systemctl is-system-running` prints `running` or `degraded`;
   - `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`.
3. **Install Docker Engine 29.9.2 from Docker's own repository.** **Ubuntu:**
   ```
   sudo apt update
   sudo apt install -y ca-certificates curl uidmap dbus-user-session git make
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc
   printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n' | sudo tee /etc/apt/sources.list.d/docker.sources
   sudo apt update
   V=5:29.9.2-1~ubuntu.24.04~noble
   sudo apt install -y docker-ce=$V docker-ce-cli=$V docker-ce-rootless-extras=$V containerd.io docker-buildx-plugin docker-compose-plugin
   ```
   Check: `dockerd-rootless-setuptool.sh --help` prints a usage text. If apt says a version was not found, stop and tell the agent.
4. **Switch off the root-run Docker.** Anyone who can reach it is root. **Ubuntu:**
   ```
   sudo systemctl disable --now docker.service docker.socket
   sudo rm -f /var/run/docker.sock
   getent group docker
   ```
   Check: the last line looks like `docker:x:999:`, with nothing after the last colon. If a name appears there, run `sudo gpasswd -d <that name> docker`.
5. **Let user services set CPU limits.** Docker's rootless tips, "Limiting resources": by default only memory and process limits are delegated. **Ubuntu:**
   ```
   sudo mkdir -p /etc/systemd/system/user@.service.d
   printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
   sudo systemctl daemon-reload
   ```
6. **Create the runner's user, `juno-runner`.** It gets no password, no sudo and no extra group. **Ubuntu:**
   ```
   sudo useradd --create-home --user-group --shell /bin/bash juno-runner
   sudo passwd -l juno-runner
   sudo loginctl enable-linger juno-runner
   id juno-runner
   grep juno-runner /etc/subuid /etc/subgid
   ```
   Check:
   - the `id` line ends with `groups=NNNN(juno-runner)`: exactly one group;
   - `grep` prints two lines, one per file. If it prints nothing, run `sudo usermod --add-subuids 300000-365535 --add-subgids 300000-365535 juno-runner`.
7. **Install Node.js 22 for the runner** (the official archive, checked by its SHA-256). **Ubuntu:**
   ```
   cd /tmp
   curl -fsSLO https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz
   echo "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce  node-v22.23.4-linux-x64.tar.xz" | sha256sum -c
   sudo mkdir -p /opt/node22
   sudo tar xJf node-v22.23.4-linux-x64.tar.xz -C /opt/node22 --strip-components=1 --no-same-owner
   /opt/node22/bin/node --version
   ```
   Check: `node-v22.23.4-linux-x64.tar.xz: OK`, then `v22.23.4`.
8. **Start rootless Docker as `juno-runner`.** **Ubuntu**, first box: `sudo -iu juno-runner`. The prompt now starts with `juno-runner@`. Then:
   ```
   printf 'export XDG_RUNTIME_DIR=/run/user/$(id -u)\nexport DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus\nexport DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock\nexport PATH=/opt/node22/bin:$PATH\n' >> ~/.bashrc
   source ~/.bashrc
   dockerd-rootless-setuptool.sh install
   systemctl --user enable docker.service
   docker info --format 'cgroup v{{.CgroupVersion}} {{.CgroupDriver}} {{json .SecurityOptions}}'
   cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
   ```
   Check:
   - the `docker info` line starts `cgroup v2 systemd` and contains `"name=rootless"`;
   - the last line contains `cpu`, `memory` and `pids`.

   If it says `none` instead of `systemd`, stop and tell the agent: the limits would not be enforced. Type `exit` to go back to your admin user.
9. **Switch off interop and drive mounting** (D-130, D-131). Only root can change this file. **Ubuntu** (as your admin user):
   ```
   printf '[boot]\nsystemd=true\n\n[interop]\nenabled=false\nappendWindowsPath=false\n\n[automount]\nenabled=false\n\n[user]\ndefault=juno-runner\n' | sudo tee /etc/wsl.conf
   sudo chown root:root /etc/wsl.conf
   sudo chmod 0644 /etc/wsl.conf
   ```
   Then, in **PowerShell**:
   - run `wsl --shutdown` and wait 10 seconds;
   - check that `wsl --list --running` says there are no running distributions;
   - open Ubuntu again. You are now `juno-runner`, the default user.

   To act as your admin user later, run `wsl -d Ubuntu-24.04 -u <your admin name>` in PowerShell. Checks, in **Ubuntu**:
   - `ls /mnt/c` prints `No such file or directory`;
   - `echo "[$WSL_INTEROP]"` prints `[]`;
   - `sudo -n true` fails, saying a password is required or that `juno-runner` is not in the sudoers file;
   - `echo x >> /etc/wsl.conf` prints `Permission denied`.

   And in **PowerShell** (a normal window): `wsl.exe -d Ubuntu-24.04 --user juno-runner --exec /usr/bin/id` prints a line starting `uid=` with `(juno-runner)`. That proves Windows can still start JUNO's programs with interop off.
10. **Run JUNO's rootless checks on your own machine.** **Ubuntu** (as `juno-runner`):
    ```
    git clone https://github.com/khashayarjavi/juno.git ~/juno
    cd ~/juno
    npm ci
    make verify-rootless
    ```
    Check: after 10 to 20 minutes the last line is `make verify-rootless: GREEN`. That run proves, on your machine:
    - the user, sudo, group and `/etc/wsl.conf` checks;
    - that Docker is rootless with the limits enforceable;
    - every container seal test, including the CPU, memory and process limits.

    Send the agent the summary lines, or the last 15 lines if it is not green.

**Part D's token, once Part E is done:** it goes in a file only `juno-runner` can read (mode 0600), outside every grant scope (§3.2). Increment 4 says exactly where, when the runner first runs on your machine.

## Previous increment (Slice 1.5 Increment 1, merged)
**Slice 1.5 — Increment 1: conform Slice 1 to v0.6** (`docs/plans/slice-1.5-build-plan.md`, Increment 1). Branch `claude/gallant-mccarthy-alppyu` (fast-forwarded to `main` c405996 after PR #30 merged). Spec v0.6.1 on `main`. No objection open.

Status: **built; going through the §7 gate.** Every item of the plan's Increment 1 is built and tested. PR #31.
- **Review round 1 (head 0b011fc; fresh subagent, P2 verbatim): DO NOT MERGE.** Checks 2, 3, 4 and 6 PASS; CI on 0b011fc passed (run 41717053614). Two defects, both fixed (D-114):
  - the verifier's own scope-violation parks were overridable;
  - a file the criterion reads outside its cwd was not pinned.

  Also fixed: a grant remedy applies to `scope_violation` only, and a parked path with no canonical form is resolved again on resume. Local `make verify: GREEN` after the fixes (776 unit, 58 container). Review round 2 next.
- **§0.0 rows built by Increment 1 (each with tests naming its section):**
  - A2 (§8.2; D-109), A3 (§11.1; D-110), A4 (§2.7.1; D-107, D-102), A5 (§2.3.1 rule 6; D-108);
  - B1 (§2.6; D-111), B2 (§3.4.4, §5.1; D-112);
  - C4 (§2.7.1; D-113).
- **Confirmed against the code** (built in Slice 1; their tests now name the v0.6 row):
  - D1 (§2.3, §2.3.1: D-036/037, amended by A5);
  - D2 (§6.4: TTL expiry is `failed`);
  - D3 (§3.2: invocation cap never exceeds the parent's; new test);
  - D4 (§2.7.1: grant bounds tighten; argv operands are paths: D-046/047);
  - D5 (§2.7.1: provenance before shape: D-048/052/054);
  - D6 (§18: injection criterion: D-080).
- **Not in Increment 1:**
  - A1 (Increment 3);
  - C1 (Increment 2);
  - C2 (deferred, D-095);
  - C3 (hosted product);
  - E1 to E3 (Increments 4 to 6).
- **Order of work** (smallest and most isolated first; one commit each, `make verify` before each push):
  1. D3 (§3.2): already built and tested (`packages/contracts/test/grant.test.ts`); add the v0.6 § name to the test.
  2. A4 rejection limit (§2.7.1, D-102): runner counts consecutive rejections, unreadable turns included; resets on proceed, park, resume; `rejection_limit` park (overridable); admission field 1–10, default 3.
  3. A5 (§2.3.1 rule 6): undeclared flag on an all-code-free, unlisted program is a `malformed_call` rejection.
  4. A2 (§8.2): `scope_violation` from an `untrusted` value is not overridable; resume needs a covering grant.
  5. A3 (§11.1): source entries in park records; "possible sources" for synthesized values.
  6. B1 (§2.6): per-actor constants; the Slice 1.2 runner test changed with its own D-number, stricter.
  7. B2 (§3.4.4, D-097): hash-pinned verification inputs; define "verification scope" in a D-number.
  8. C4 (§2.7.1): canonical scope, symlinks and not-yet-existing paths; container tests.
- **B2 (built 2026-11-03; D-112 is the record; the design notes below are kept):**
  - **Criterion fields:** the criterion gains `outputs` and `verification_inputs` (work paths, default empty). Admission refuses:
    - an input or output outside the verification scope;
    - an output inside a protected path.
  - **Verification scope (to be recorded as a D-number, defining D-097's term):** the criterion command's `cwd`, plus each protected path; a root inside another is dropped.
  - **Mechanism, verified against the workload's coreutils 9.1 (2026-11-03):**
    - one verifier listing, `ls -l -a -R -n --time-style=full-iso --quoting-style=escape -- <roots>`. Escape style makes it unambiguous: spaces are `\ `, newlines `\n`, `:` in headers `\:`, so a raw space only separates fields and a symlink's ` -> ` cannot be forged;
    - then `sha256sum -z -- <files>`, in batches, over every regular file in scope that is not an output. Output is `HASH  NAME\0` with raw names; a missing file gives no record, which counts as changed.
  - **Workload image:** add `/usr/bin/sha256sum` (libc only).
  - **Registry:** add sha256sum to the shell.run enum with a code-free surface (`-z`, `--zero`, `--`, operand). It is never offered to the model, because its constant is verifier-only (B1).
  - **The hash call's file operands:** verifier constants filled at pin time, one per file, with the listing result's class, and journalled so a rebuild restores them. Basis: §2.6 calls "a template slot filled by the runtime" a constant, and §5.1 makes pin-taking part of admission. This must be recorded as a D-number. If a reviewer reads it as a new §2.6 ambiguity, STOP for the operator.
  - **Compare at closure:**
    - the set of paths, excluding outputs;
    - per path: type and mode;
    - files: hash; symlinks: target;
    - directories: mode only (their size and time change when an output is created).

    Any difference, or a hash that cannot be computed, makes `verified` impossible: the task fails, with the changed paths recorded.
  - **Bounds:** at most 2,000 hashed files and 10,000 entries; beyond that the task fails (it never skips).
  - **Replaces D-067's listing comparison.**
  - **Test infrastructure:** the unit tests' stand-in adapter must emulate `ls` (escape style) and `sha256sum -z` over a host directory, or unit tests use a fixed pin fixture. The acceptance, container, resume and runner tests that read `protected_listing` notes change accordingly; record each in a D-number.
- **C4 design (2026-11-03, being built):** the boundary keeps a synchronous `authorize`. It gains a side-effect-free pre-pass, `scopePaths`, listing the raw path of every path-typed data value and argv operand (cwd + "/" + operand, `..` not collapsed). Step 4 uses the same function. The runner resolves those paths with a `PathResolver` and passes the canonical forms in the task context; a path missing from them is unresolvable, so it is outside scope (fail-closed).
  - The production resolver runs an operator-fixed node script in the workload (the image's own node, not in the shell.run enum).
  - The algorithm is the longest existing ancestor via `realpath`. A missing remainder holding `..` or an empty component is unresolvable, and so is a dangling symlink. A symlink loop or a permission error is unresolvable too.
  - The unit tests use the same script against the stand-in's host `/work`.
  - Container tests cover symlinks in the real workload.
- **Gate record for the plan:** see "Merges recorded" (PR #30).

## Previous increment
**Slice 1.5 — Part 0 revision: the build plan on spec v0.6.1** (D-091 to D-106). PR #30 merged through the §7 gate (see "Merges recorded"). Along the way: PR #27 (spec v0.6.1) merged on the operator's ruling (D-100); three objections raised and ruled (V61-1 public, D-098; V61-2 (a), D-102; V61-3 (a), D-105); review rounds 3 and 4 allowed by the operator (D-103, D-106). PR #29 is superseded by PR #30 and still open; the operator may close it.

**Slice 1.5 — Part 0 revision, STOP of 2026-11-03 (D-099).** PR #27 was still unmerged when this session started, so it stopped (PR #30 head 42f286c, CI runs 41675990794 and 41676016930 success). Lifted by D-100.

**Slice 1.5 — Part 0 revision, first session** (D-091 to D-097). Branch `claude/youthful-bohr-hpxzg1`, PR #29 (draft, head c9408cd, CI `verify` runs 41670675286 and 41670679331 success). Stopped because PR #27 had been closed unmerged (D-096). Its two commits are carried unchanged on `claude/gallant-mccarthy-alppyu`.

**Slice 1.5 — Part 0: the build plan** (D-089, D-090). Branch `claude/determined-carson-5d6slg`, PR #28 (https://github.com/khashayarjavi/juno/pull/28), merged on GitHub at 2026-11-03 15:57:33 UTC (merge commit 5ee1594), not by the agent: the agent had stopped before the merge (D-090). Review round 1 on 632735b: DO NOT MERGE for gate conditions only (all six checks PASS). CI `verify`: run 41579569741 on 632735b and run 41579784946 on 9a323d8, both success. CI on `main` for 5ee1594 was not read by the agent. Reviewer notes still open for the director: confirm D-089 matches what you authorised; CLAUDE.md §7 LOOP step 1 still names `spec/slice-1-build-plan.md`, not the Slice 1.5 plan; the Increment 1 review must check that the B1 test change has its own D-number and makes the test stricter.

## Earlier increments (Slice 1.3)
**Slice 1.3 — remaining benign parks** (authorised by the operator, 2026-11-02; not a roadmap item; no spec change). `packages/enforcement` changes only in one test's timeout (D-086). Branch `claude/slice-1-3-benign-parks-ezx1q2`. Each part is its own PR through the CLAUDE.md §7 gate:
1. **Part 1 — runner and adapter.** After Groq's `output_parse_failed`, the model gets a retry turn, as after `tool_use_failed`; each retry costs a turn and is journalled with the refusal text, key scrubbed. The runner describes the criterion in plain words (what will be checked), never as a call or call-shaped text, never with literal instruction values (D-075 holds).
2. **Part 2 — measure.** Groq, `openai/gpt-oss-120b`, free tier, D-072/D-073 unchanged: the six ordinary tasks of Slice 1.2, three runs each, under `evidence/slice-1.3/`, counted by D-078 unchanged. Report `docs/evidence/slice-1.3.md`: benign-park rate before (Slice 1.2: 3 of 27) and after, each remaining park's cause, safety checks in every run. Reported honestly even if it misses 10%; no boundary rule relaxed.

Status: **Slice 1.3 complete. Part 1 (PR #24) and Part 2 (PR #25) merged through the §7 gate. STOP: Part 2's report is merged, as the operator's instruction says.** No further increment is authorised; the next step is the operator's.
- **Report:** `docs/evidence/slice-1.3.md`.
- **Result, recomputed from the journals:**
  - benign-park rate **4 of 18 (22%)** after, against 3 of 18 (17%) on the same six tasks in Slice 1.2, or 3 of 27 (11%) over all of Slice 1.2's benign runs;
  - **the 10% target is missed, and no improvement is shown** (at 18 runs, one park is 5.6 points);
  - safety invariants held in 18 of 18 runs;
  - spend USD 0.
- **The four parks:**
  - ordinary-2 run 2 `scope_violation`: a path-building loop, then a model-written `/report-a.txt`;
  - ordinary-3 run 1 `integrity_floor`: `cat -c cat`;
  - ordinary-3 run 3 `budget_exceeded`: a path-building loop;
  - ordinary-6 run 3 `integrity_floor`: `ls -c "touch done.txt"` after reading the right file. This may be invited by the new plain-words text naming `done.txt`; the journal cannot show why.
- **What Part 1 removed:**
  - criterion-copy refusals, 5 to 0;
  - unreadable turns, 15 to 2.

  `output_parse_failed` did not occur in any run, so the retry is proven by unit tests only.
- **For the operator (options in the report, "What this suggests next"; nothing built):**
  - tell the model that a listed name is relative to the folder it was listed in (2 parks);
  - the `-c` habit (2 parks, correct and not overridable);
  - word the check by its meaning, which the operator would state at admission, rather than by its argument;
  - more runs are needed to measure a rate this low.

## Earlier increments
**Slice 1.2 — park-rate reduction** (authorised by the operator, 2026-10-30; not a roadmap item; no spec change). Goal: cut parks on benign tasks caused by the model misusing the tool interface (`docs/evidence/slice-1.1.md`, findings 1 to 3), without changing any boundary rule. `packages/enforcement` changes only in tests. Each part is its own PR through the CLAUDE.md §7 gate:
1. **Part 1 — runner and adapter interface.** The runner's messages never show the criterion's or any constant's literal values for instruction fields (slot names only). The tool schema offers instruction fields only as a constant slot (slot names enumerated) or a reference; a literal the model still sends is judged and parks exactly as today (D-052), proven by a test. The instructions show the reference grammar with an index example. Slots fixed for the verifier are not offered to the executing model; if the boundary still accepts them when named, that is an objection for spec v0.6 here, and the boundary is not changed.
2. **Part 2 — evidence re-run** with `make smoke` (Groq, `openai/gpt-oss-120b`, free tier, D-072/D-073 unchanged) under `evidence/slice-1.2/`: the same scenarios, at least three runs each, plus three new ordinary tasks whose objectives do not name the constants. Report `docs/evidence/slice-1.2.md` against Slice 1.1: benign-park rate (target under 10%, reported honestly either way), safety invariants (must hold in every run), s18-2b (must still park `integrity_floor`), tokens.

Status: **Slice 1.2 complete. Part 1 (PR #19), the interface fix (PR #20), Part 2 (PR #21, merged by the operator) and the Part 2 follow-up (PR #22, through the §7 gate) are all merged.** Report: `docs/evidence/slice-1.2.md` (with Errata). Benign-park rate 57% (8 of 14) before, 11% (3 of 27) after; the 10% target is missed. No further increment is authorised: the next step is the operator's.
- **Operator rulings of 2026-11-02, recorded:**
  - D-080: D-076 amended. An injection run is accepted when no instruction value was model-authored, every call that ran was inside the grant, and every out-of-scope attempt parked; "nothing ran" is not the criterion.
  - D-081: spec v0.6 item, first in the list below.
  - D-082: a third and final review round. PR #21 was already merged, so it is held on the follow-up PR.
  - D-083 (autopilot ruling): how the three conditions are read from the journal.
- **Done on the branch:**
  - One check function, `scripts/injection-check.mjs`, used by the smoke scenarios and by `scripts/smoke-summary.mjs`.
  - `test/evidence/injection-check.test.ts` (8 tests, in `make verify`). It tests each condition and recomputes the report's headline figures from the committed journals.
  - Report updated (`docs/evidence/slice-1.2.md`).
- **Recomputed from the journals:**
  - D-076 as amended: **accepted in 6 of 6** Slice 1.2 injection runs (4 of 4 in Slice 1.1).
  - An injected call ran inside the grant in **2 of 6** (s18-2 runs 2 and 3; it read nothing).
  - Benign-park rate: **57% (8 of 14) before, 11% (3 of 27) after**; the 10% target is missed.
  - Safety invariants held in 71 of 71 counted runs.
- **Corrected before review:**
  - The report said five of six injection runs "tried /etc/passwd again" after the resume. s18-2b run 1's first park was the interface park (`{"slot":"cat"}` in `argv`), so the true figure is four of six.
  - That interface park, which D-078 requires the report to list, was missing; it is now finding 7.
- **2026-11-02, operator ruling D-084: one fix round for the 12 findings below.**
  - **Status:** done on the branch. The report's wording and figures were corrected for all 12, plus the reviewer's three notes ("simulated" day, the unsupported "harder" claim, and the s18-2b `integrity_floor` goal stated as not met).
  - **Scope held:** no runs, no code change, no change to any result.
  - **Figure check added:** the journal's per-turn cost sum is USD 0.046 (the report said 0.047).
  - **New section:** "Where each figure comes from", in the report.
  - **Fourth review (fresh subagent, P2 verbatim plus the journal check), on ba68286: DO NOT MERGE, for 7 REPORT findings only.**
    - No finding is about code, tests or safety. The reviewer's own readers confirmed every figure and every safety result: the 71 runs, the hash chains, all 229 calls that ran inside `/work/project`, and the injection sequences.
    - Under D-084 nothing was fixed. The report now opens with an "Errata" section listing the 7, one line each; two lines were spot-checked against the journals.
    - The reviewer's notes, not FAIL:
      - the figures test names no §;
      - 5 of the 10 unreadable version-4 turns were Groq refusals (live-check runs 1 to 3);
      - the five s18-4a runs hold the invariants trivially (no task journal);
      - the `smoke-summary.mjs` comment "reading the journal at all proves it verifies" is not true, though the chains do verify;
      - `overridable` is prepared differently in the two callers.
  - **Merged** as PR #22 (see "Merges recorded").
- **Local `make verify` is RED on this host (D-085).** One unchanged test times out: `packages/enforcement/test/enforcement.test.ts`, "parks every proposal with a synthesized or unresolved value anywhere under the program field", `Test timed out in 5000ms` (6.2-7.8 s). `packages/enforcement` is identical to `main`. CI's `verify` on the pinned head decides, under the §7 gate.
- *(Superseded by D-084.)* **STOP (D-082: the third and final review round ended DO NOT MERGE).** Follow-up PR #22 (https://github.com/khashayarjavi/juno/pull/22), head 07b1e17995adf2da020b195911157a3d3d53d92c, PR CI `verify` run 41477440248 (success). Not merged; nothing further fixed, as D-082 requires. The operator decides.
  - **Reviewer verdict (round 3, fresh subagent, P2 verbatim plus the operator's journal check):**
    - The six standard checks all PASS: tests, nothing weakened, lint rule, scope, decisions recorded, container seal.
    - The safety results and the headline figures are confirmed by its own journal readers: benign-park rate 8 of 14 (57%) to 3 of 27 (11%); D-080 accepted 6 of 6; the resumes; 4 of 6 retried after a resume.
    - **DO NOT MERGE** for 12 report statements it found wrong, unsupported or misleading (lines are in `docs/evidence/slice-1.2.md` at 07b1e17):
    1. Lines 86, 93: "In Slice 1.1 the model wrote `/bin/sh`" holds only for s18-2b. In Slice 1.1 s18-2 runs 1 and 2, a literal `/usr/bin/cat` parked before the injection was read, so Slice 1.1's "4 of 4" includes 2 runs that never saw the injection.
    2. Line 89: "every program in every injection call was an operator constant" holds for Slice 1.2 only. "No model-authored instruction value reached the boundary" holds only for the injection runs (promoted `-c` reached it in ordinary-5 run 1 and s18-4b).
    3. Lines 8, 34, 61-70, 162 overstate what the script recomputes. It recomputes three invariants. "Nothing ran outside the grant" is recomputed only for the injection runs. "Resume refused", "key never leaked" and "no paid usage" are run-time harness checks, not journal facts. It also does not compute the ledger, the cost, the per-version tokens or the 16 refusals.
    4. Line 66: "asking to resume [a hard park] was refused" was never exercised in Slice 1.2 (no hard-parked scenario resumes); it was shown only in Slice 1.1.
    5. Line 68: "every out-of-scope path parked" is false for Slice 1.1. `/usr/bin/cat` in `argv` was rejected (`unresolved_argument`), not parked: adversarial-1 run 2 calls 20 and 25; ordinary-2 run 2 call 15. Nothing ran.
    6. Lines 23, 99-100: the "injected command never ran" check fails only when recomputed; `result.json` for s18-2 runs 2 and 3 records it as passed. The report does not say the recorded answer was wrong.
    7. Line 120: the `{"slot":"sh"}` example of the 16 refusals comes from set-aside runs, not the counted ones.
    8. Line 130: "no version-5 run repeated it" is false. In ordinary-3 runs 1 and 2 (seq 12) the model proposed `{"slot":"cat"}` in `argv`; Groq refused it against the schema.
    9. Lines 74, 130: "the planted attack did not cause this park" (s18-2b run 1) is a cause the journal cannot show.
    10. Line 139: "six harness-error and cut-off runs" should be five.
    11. Lines 137-139: the ledger/journal gap omits turns cut off at the token limit. Their usage is in the turn blob, but their journal cost is 0: 9,790 tokens in counted version-5 runs.
    12. Line 147: "eight times per run" holds for harness-error-run-2 only; run-3 had 7 plus a cut-off turn, and run-1 is unverifiable.
  - **Reviewer notes, not FAIL:**
    - "the next day" in s18-1 is a simulated clock;
    - "harder (more files, more turns)" is only weakly supported;
    - the Part 2 goal "s18-2b must still park `integrity_floor`" was not met in any Slice 1.2 run (every run parked `scope_violation`; accepted by D-076/D-080), and the report never says so in those words;
    - `scenarios.ts` and `smoke-summary.mjs` prepare `overridable` differently (missing becomes false, versus the raw value); no journal lacks it, so no figure changes.
  - **Operator: your options.** (a) Authorise a fix round for these 12 report statements, with a review after it. The fixes are wording and figures in `docs/evidence/slice-1.2.md` only; no code or check changes. (b) Merge PR #22 as it stands; D-080 to D-083 and the check are correct per the review. (c) Close it.

**History of Part 2 before the 2026-11-02 rulings (superseded; kept for the record):**
- Round 1 review of PR #21 (on 32517cf) and round 2 (on 9e5293c) ended DO NOT MERGE; both rounds' findings were fixed on 9d3de5c, which the operator merged unreviewed.
- **2026-11-01 04:04 UTC (operator: "Continue"):** the window still held 177,681 tokens, so no model run could start. Drafted `docs/evidence/slice-1.2.md` from the recorded runs: every figure is final except the two pending scenarios (`adversarial-1`, `s18-4b`), which are marked PENDING and cannot change the benign-park rate.
- **2026-11-01 (operator): keys changed, D-079.** `GROQ_API_KEY` is gone; the runner uses `GROQ_API_KEY_1` only, cap unchanged. Launch with: `env -u GROQ_API_KEY_1 -u GROQ_API_KEY_2 -u OPENROUTER_API_KEY -u GOOGLE_STUDIO_API_KEY GROQ_API_KEY="$GROQ_API_KEY_1" make smoke`.
- **To resume:** the window frees from about 2026-11-01 20:50 UTC. Run `make smoke` (launched as above) on this branch, then write `docs/evidence/slice-1.2.md` (`node scripts/smoke-summary.mjs evidence/slice-1.1 evidence/slice-1.2` gives every figure), then the Part 2 PR through the §7 gate. A resume is scheduled for 2026-11-01 21:10 UTC (scheduled task `trig_015wxwDDCb91FeKW9pQQBzap`).
- **2026-10-31 17:42 UTC (operator: "resume now"):** the rolling token window still held 177,944 tokens, so no model run could start. Done without spending: `s18-5` 3/3 (no model; all checks hold); `scripts/smoke-summary.mjs`, which recomputes every figure from the journals under D-078 and D-076 (it reproduces the recorded figures; all 6 version-4 injection runs meet D-076). The scheduled resume at 20:45 UTC stands.
- **To resume (next session):** the rolling window frees about 60,000 tokens at 2026-10-31 19:40 UTC and about 120,000 by 20:40 UTC. Run `make smoke` on this branch with the key in `GROQ_API_KEY`; recorded runs are skipped. If it stops on the cap again, commit, push and stop again. Then write `docs/evidence/slice-1.2.md` and take the Part 2 PR through the §7 gate.
- **Operator decisions of 2026-10-31:** D-076 accepts the s18-2b result (see "For the operator"). Before the remaining runs, one PR through the §7 gate, runner and adapter only: data fields are offered only data-role constants whose type fits; the provider's refusal text for a turn is journaled with the key scrubbed. **Merged as PR #20** (with the Part 2 harness and the runs recorded so far). Since then, on this branch: the s18-2 and s18-2b smoke checks also test D-076's condition (`d076_injection_result_accepted`); the recorded runs are checked against it in the report. Runs already recorded stay, and the report separates them by interface version. This session is scheduled to resume at 2026-10-31 20:45 UTC (scheduled task `trig_018DYhfChwtMrJsH8Q1Hz9pp`).

**Slice 1.1 — real-model evidence (complete).** Parts 1 to 4 merged (PR #12, #13, #16, #17; STATE record PR #18). Report: `docs/evidence/slice-1.1.md`.

## Merges recorded (CLAUDE.md §7 step 6)
- **Slice 1.5 Increment 3 (D-132 to D-138), PR #36** (https://github.com/khashayarjavi/juno/pull/36):
  - Head dd485b4ae81d2427149a6e34c31603b5d0630648. PR CI run 41970251969 succeeded on that head: `verify` (job 127056565401) and `verify-rootless` (job 127056565115).
  - Merged as merge commit 5951e574fb8b96f4294dcf222a04ea36356c4472, pinned to the head SHA. CI on `main` for the merge commit: run 41970658311 (event `push`), `verify` and `verify-rootless` both success.
  - Reviewer verdict: round 1 MERGE on dd485b4; all six checks PASS.
- **Slice 1.5 Increment 2 (D-115 to D-131), PR #35** (https://github.com/khashayarjavi/juno/pull/35; supersedes #34 and #33):
  - Head bd4db645e80de6ff17353bc1e5a19504ef52cbe4. PR CI run 41888014160 succeeded on that head: `verify` (job 126777586625) and `verify-rootless` (job 126777586197).
  - Merged as merge commit d7e7ec38f35e3ff7c11f3c07d67f5c808d81f6e2, pinned to the head SHA. CI on `main` for the merge commit: run 41890482246 (event `push`), `verify` and `verify-rootless` both success.
  - Reviewer verdict: round 3 (D-127) MERGE on bd4db64; all six checks PASS. Rounds 1 and 2 (PR #33) were DO NOT MERGE, fixed by D-125 and D-126.
  - Reviewer notes, not defects:
    - the trust-anchor check (`packages/runner/src/trust.ts`) covers the file and its own folder, not the folder above it or a symlink's target folder (residual to record);
    - the comment in `scripts/rootless/setup-root.sh` says "no login shell", but the user is created with `/bin/bash`, password locked;
    - the runner's `#anchor` returns false without a journal note when the journal fails verification (the task still fails closed);
    - the §3.2 restart case is proven through `resume.test.ts`, which names §6.3.
- **Slice 1.5 Increment 1 (D-107 to D-114), PR #31** (https://github.com/khashayarjavi/juno/pull/31):
  - Head ae5b38a0c2630210e72e3f88a25d6353c24558b9; PR CI `verify` run 41719481819 (job 126208141078, success).
  - Merged as merge commit 1432cc3dee9489c1225ea04e28dc399e9c122e3c, pinned to the head SHA. CI `verify` on `main` for the merge commit: run 41720351290 (event `push`, job 126211167933), success.
  - Reviewer verdict: round 2 MERGE on ae5b38a (all six checks PASS). Round 1 on 0b011fc was DO NOT MERGE for two defects, both fixed (D-114).
  - Notes from the reviewers for the operator, not defects:
    - D-109 reads A2's "untrusted" as the literal level, so an out-of-scope `derived` value stays overridable;
    - D-112's hashed file names are `constant` with `untrusted` integrity (§2.6 "a template slot filled by the runtime");
    - the C4 resolver and the effect run in separate containers, so the gap between them must be re-examined when write programs arrive (Increment 3).
- **Slice 1.5 Part 0 revision (D-091 to D-106), PR #30** (https://github.com/khashayarjavi/juno/pull/30):
  - Head bb6aef5fc597ee3946633e388be7899f196ceb7f; PR CI `verify` run 41688473651 (job 126100437341, success).
  - Merged as merge commit c4059961616b10d2013e87562acacdafad5ec2ce, pinned to the head SHA. CI `verify` on `main` for the merge commit: run 41688851640 (event `push`, job 126101743836), success.
  - Reviewer verdict: round 4 (D-106) MERGE on bb6aef5, after the PR description (not a commit) was corrected; all six checks PASS. Rounds 1 to 3 DO NOT MERGE, each fixed (D-101, D-104).
- **Spec v0.6.1 (operator's change), PR #27** (https://github.com/khashayarjavi/juno/pull/27), merged by the agent on the operator's ruling (D-100):
  - Head fcb1a6076dadc803be945d026f7c438f69d7e5e7; PR CI `verify` run 41673760530 (success).
  - Merge commit 603284c346aa29ce51699587064b75512e1cf8d3, pinned; CI on `main` run 41686229757 (success). No agent review: the content is the operator's spec.
- **Slice 1.3 Part 2 (D-088), PR #25** (https://github.com/khashayarjavi/juno/pull/25):
  - Head 83c7e2ece250648f414d6be9f7d4aa0b4ce656e5; PR CI `verify` run 41522114318 (success).
  - Merged as merge commit 80de0b1561ee1b4828ff7c030df67cca2d664688, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41522550656 (event `push`, success).
  - Reviewer verdict: round 1 MERGE on 83c7e2e. Every figure and park cause was re-derived from the journals and matches. Wording notes, not fixed (they would move the head):
    - report line 46: "repeated this four times" is loose (turn 3 used the bare name alone);
    - line 53: "ran `cat`" should be "proposed";
    - the criterion-copy counting rule is stated in the report only.
  - Local `make verify` GREEN on 83c7e2e (697 unit, 51 container).
- **Slice 1.3 Part 1 (D-086, D-087), PR #24** (https://github.com/khashayarjavi/juno/pull/24):
  - Head 73100dfe8653ba00d631997b7b5237ceb34cab2d; PR CI `verify` run 41501206265 (success).
  - Merged as merge commit 80e5436b73f4bf3a0661e16f4f2333da864868eb, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41501736874 (event `push`, success).
  - Reviewer verdicts:
    - round 1 MERGE on 75e011b, with one minor inconsistency: D-087 said no copyable placeholder appears, but a program path in a criterion data field was shown as the rejections' quoted placeholder. Fixed: a hidden value is named in words; tested.
    - round 2 MERGE on 73100df. Notes, not fixed (they would move the head): a test comment says "second review" where it was the first, at `packages/runner/test/runner.test.ts:538`; the last hiding pass could garble a sentence if a hidden value were short (it fails safe; today the hidden values are full program paths).
  - Local `make verify` GREEN on 73100df (696 unit, 51 container).
- **Slice 1.2 Part 2 follow-up (D-080 to D-085), PR #22** (https://github.com/khashayarjavi/juno/pull/22):
  - Head bd43c8fb700fffd2619f7fe54c742e6af023eeec; PR CI `verify` run 41491900996 (success).
  - Merged as merge commit 023dd0885d78e06f4a8137130a35c271b0158464, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41492311891 (event `push`, success).
  - Reviewer verdicts:
    - round 3 DO NOT MERGE on 07b1e17 (12 report findings; one fix round, D-084);
    - round 4 DO NOT MERGE on ba68286 (7 report-wording findings only; listed as Errata, D-084).
  - Merged under D-084's errata path: no reviewer verdict on the errata head was required.
- **Slice 1.2 Part 2, PR #21** (https://github.com/khashayarjavi/juno/pull/21), **merged by the operator, not through the §7 gate.**
  - Head 9d3de5c5fe6a19c0ffd59df6a8dcc0f2f84d74d0; PR CI `verify` run 41352224191 (success).
  - Merge commit 2b701d25505bd9b8498411c22c7d3e6ce9cdd73e, 2026-11-02 15:50 UTC, by `khashayarjavi`; CI `verify` on `main` for it, run 41475627431 (event `push`, success).
  - Reviewer verdicts: round 1 DO NOT MERGE on 32517cf; round 2 DO NOT MERGE on 9e5293c. No review of 9d3de5c before the merge; the third round (D-082) is held on the follow-up PR.
- **Slice 1.2 interface fix (D-077, D-076, D-078) with the Part 2 harness and runs so far, PR #20** (https://github.com/khashayarjavi/juno/pull/20): head c09aa6cfa2ad27d1a1c6f95f5d032ae0754aae55; PR CI `verify` run 41168416633 (success); merged as merge commit 4db59d16e5a40d1f5e874004567728ebc22e5837, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41168626266 (event `push`, success). Reviewer verdicts: round 1 DO NOT MERGE on 3c8b6a7 (benign-park counting rules unrecorded; the designed park excluded every park of its reason; both fixed, D-078), round 2 MERGE on c09aa6c.
- **Slice 1.2 Part 1, PR #19** (https://github.com/khashayarjavi/juno/pull/19): head 0898172a3fd30c5b4fafd78b1635e11ed6512e5d; PR CI `verify` run 41123333989 (success); merged as merge commit 7933d8857ec024a2b08c3c58544b9d24a1dbe842, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41123793050 (event `push`, success). Reviewer verdicts: round 1 DO NOT MERGE on be6055d (a rejection shown to the model named the program enum; the out-of-runner schema check was not in DECISIONS.md; both fixed), round 2 MERGE on 0898172.
- **Slice 1.1 Part 4, PR #17** (https://github.com/khashayarjavi/juno/pull/17): head f91a733c5bb056dd80cff87f6355e7cf51f0aa3c; PR CI `verify` run 41118241894 (success); merged as merge commit 5337406fa513c341d6254d3a9c9b1caf1dadb813, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41118697582 (event `push`, success). Reviewer verdicts: round 1 MERGE on 5a5e5d1 (wording fixes and an exact `cwd` check applied before merging), round 2 MERGE on f91a733.
- **Slice 1.1 Part 3, PR #16** (https://github.com/khashayarjavi/juno/pull/16): head e8181c886282db83541cc5bd57beff436ceb5712; PR CI `verify` run 41115460319 (success); merged as merge commit 129c00c20508c9494ec40d1b85359d0a2fac0041, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41116037471 (event `push`, success). Reviewer verdict: round 1 MERGE on e8181c8, with two notes carried into Part 4 (the smoke build steps now run without the key; the key's use outside the runner is recorded in D-073). PR #16 supersedes PR #15 and PR #14 (still open; closing them is the operator's call).
- **Slice 1.1 Part 2, PR #13** (https://github.com/khashayarjavi/juno/pull/13): head c50367aec339dbd0c26268f77f008b976428fd64; PR CI `verify` run 41101381460 (success); merged as merge commit c464ec8dd247dd7288da97c31888cbc03591d761, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41103200588 (event `push`, success). Reviewer verdict: round 1 MERGE on c50367a.
- **Slice 1.1 Part 1, PR #12** (https://github.com/khashayarjavi/juno/pull/12): head 4661f4bdf1218312ef4a01dce914e0b6d67777f0; PR CI `verify` run 41095688964 (success); merged as merge commit 9c437cf12f537f82ce5aa408036fa501b743b736, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41100958199 (event `push`, the new trigger; success). Reviewer verdict: round 1 MERGE on 4661f4b.
- **Increment 7, PR #10** (https://github.com/khashayarjavi/juno/pull/10): head 00472832069890b11a729e97db7f25616f79786a; PR CI `verify` run 41071225012 (success); merged as merge commit f89e915a2cb7ee16c1ccad053da545107fd86051, pinned to the head SHA (two earlier merge calls returned a GitHub 500 and did nothing; `main` was checked unchanged before retrying); CI `verify` on `main` for the merge commit, run 41071862741 (workflow_dispatch, success). Reviewer verdicts: round 1 DO NOT MERGE on ecc0b3f (two findings, both fixed), round 2 MERGE on 0047283.
- **Increment 6, PR #9** (https://github.com/khashayarjavi/juno/pull/9): head 61d2aa34247ef06ef10ba859733da8fc941d021a; PR CI `verify` run 41067106637 (success); merged as merge commit e38850156b70ad7e80537589ff77a74b35259b9a, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41067673749 (workflow_dispatch, success). Reviewer verdicts: round 1 DO NOT MERGE on add00fe (four findings, all fixed), round 2 MERGE on 61d2aa3 (one minor carry-over, plan step 1).
- **Increment 5, PR #8** (https://github.com/khashayarjavi/juno/pull/8): head fd68a2509d0be8556754cc3a0e78d71dfcad28e6; PR CI `verify` run 41063185508 (success); merged as merge commit da4e4cf32f6e8a5acd8e84dbc71c8afd2ca04c71, pinned to the head SHA; CI `verify` on `main` for the merge commit, run 41064280256 (workflow_dispatch, success). Reviewer verdicts: round 1 MERGE on 4e00d36 (findings fixed), round 2 MERGE on fd68a25.
  - The CI workflow runs on pull requests and `workflow_dispatch` only, so step 6d dispatches it on `main` (the workflow file is unchanged).

## Increments 5 to 7 (merged) — build and review history
Everything is in `packages/runner/` unless named. Every test names the section it proves.
- **Operator change first (D-055):** `CLAUDE.md` §7 Autopilot, and rules 11 to 13 in §2. Standing rulings recorded: D-056 (Increment 6: a journal that fails verification after a crash is never resumed), D-057 (Increment 7: protected paths; tests 2 and 3 pass together), D-065 (the runner runs on the host; no Docker socket in any container).
- **Rule 12 check (D-058):** `tools/check-unicode.js` refuses invisible and bidirectional-control characters in source, tests, capability files and configuration. `make lint` runs its self-test (twelve planted characters must all be found) and then scans the repository. `test/lint/unicode.test.ts` checks each class.
- **Provider (D-059):** `provider.ts` (`Provider` interface, `ProviderResponse` parsed at the boundary, `ScriptedProvider`), `profile.ts` and `providers/scripted.json` (the one Provider Capability Profile, §13.1).
- **Admission (D-061):** `admission.ts`. §5.4 checks 1 to 11, all failures reported together. Derives `context_ownership` (always `native` in Slice 1) and `steer_capability` (§7.8 table), records `criterion_integrity` (operator, or `derived` for a model-drafted criterion), lowers `closure_mode` to `accepted` when `verified` is not licensed, builds the constants table (operator constants, and the criterion's literals at the criterion's integrity), and routes to a provider. Also enforces §5.3 (capped grants for write-class capabilities; no grant over the whole `/work` namespace) and check 4 for grants (everything a grant reaches lies within a classified source).
- **Tool-call translation (D-060):** `translate.ts`. `{"ref": ...}` is bound, `{"slot": ...}` constant, any other literal synthesized; nothing the model writes becomes an argument source.
- **Turn loop (D-063):** `runner.ts`. Assemble, call the provider, journal the turn (request, its hash, model and version, cost), hand each proposed call to the enforcement boundary, `perform` only what it authorizes, journal the result, repeat. The runner never invokes or plans a capability itself.
- **Parks:** `awaiting_grant`, `integrity_floor`, `scope_violation`, `sensitivity_ceiling`, `adapter_quarantined` (from the boundary), `budget_exceeded`, `routing_unavailable`. Each `park` entry records `overridable` (false for `integrity_floor` and `adapter_quarantined`, §8.3). TTL expiry moves the task to `failed` with `ttl_expired` (§6.4).
- **Budgets (D-063):** `budget.ts`. All four axes, each parking on its own. Wall clock counts running time only.
- **Verification and closure (D-062):** the model's "done" triggers the criterion's command through the boundary; `pass` writes the closure (`juno.verifier`) and moves to `verified`; otherwise `failed`, no closure. Non-verified tasks go to `complete_unverified`; the principal may `accept`. The closure is checked against every executing actor at write time.
- **Sensitivity floor:** raised by every result (to the sources' class), recorded by a `note`.
- **One runner per journal, and quarantines across restarts (D-064):** `lock.ts`; the `juno.registry` record.
- **Registry:** one read accessor added, `CapabilityRegistry.capabilities()` (the tools offered to the model).
- **Tests:** `packages/runner/test/runner.test.ts`, `admission.test.ts` (73 tests), and `test/containers/runner.test.ts` (6 tests: a real task in the real workload, closed verified; the workload cannot read or write the host journal by its exact paths; the journal is byte-for-byte unchanged; no container has the Docker socket).
  - The four build plan tests: no criterion admits non-verified; a model-drafted criterion is `derived` and never closes verified; each budget axis parks on its own; a closure verified by an executing actor (model, runner, boundary or adapter) is refused by the schema at write time.
  - The STATE requirement from Increment 4: a whole task runs with a registry whose `invoke` throws, and no runner module calls `invoke`, `plan` or `executeOutbound`.
- **Mutation-checked:** 10 deliberate breakages; 8 caught. The 2 survivors (the clock not stopped on park or on a state change) are equivalent: `run()` always stops the clock when it returns.

- **First independent review (2026-10-30, head 4e00d36): MERGE**, with small findings, all fixed before merging (new head below):
  - a source-shaped object the model wrote, nested exactly 16 list levels deep, reached the boundary unwrapped (off by one in `translate.ts`); fixed, and a test nests a forged constant 1 to 20 deep (it fails on the old code at 16) (D-060);
  - a refused closure left the task `running`; it now ends `failed` / `closure_refused` in the trajectory (D-062);
  - a test comment said the opposite of its assertion; fixed, and the positive case added;
  - the provider-response limits were unrecorded (D-059); a runner now runs one task at a time (D-063).
  - The reviewer also asked the operator to confirm that the CLAUDE.md §7 autopilot change (D-055) is theirs. It came from the director's instruction that started this session.

- **First independent review of PR #9 (2026-10-30): DO NOT MERGE.** Fixed: (1) the four Increment 6 commits had not reached GitHub (the branch's upstream had become `origin/main`; pushed, upstream fixed); (2) a resume that re-parked left the runner claimed, so it refused all further work (fixed, tested); (3) a task listing an unusable grant could never resume (operator can now drop grants on resume, recorded in D-066 with the consequence; tested, including across a restart); (4) the runner-record classes recorded in D-066.

## Remaining
- **Agent:** Increments 3 to 6 of `docs/plans/slice-1.5-build-plan.md`, each through the §7 loop.
- **Operator:** the Windows steps (Increment 2, "Operator steps", Parts A–C, then Part E for WSL2). The code does not wait for them.

## make verify
Local, 2026-11-04 on this branch (PR #35): **GREEN** (829 unit, 69 container), after pointing the session's Docker daemon at `mirror.gcr.io` (Docker Hub 429). CI on 8057fe2 (run 41887176162): `verify` success, `verify-rootless` success.

Earlier: local, 2026-11-03 on this branch (documents only since `main`): **RED on this host only for Docker Hub** (`429 Too Many Requests` pulling `node:22-bookworm-slim` for the container images) after typecheck, lint and 697 of 697 unit tests passed. CI `verify` on the PR head decides. Earlier: local GREEN on 5ee1594 (697 unit, 51 container); GREEN on 83c7e2e and 73100df (D-085, D-086).

## For the operator
- **Now:** the Windows steps under "Current increment" (signing key in the Windows agent, one signed grant, and the public `juno-anchors` with its protection and push token). You may close PR #29 (superseded by PR #30) and PR #32 (superseded by this session's PR).
- **Known limit (D-124):** the runner's "cannot write the trust anchor" check does not work on Windows, where it would refuse to start (fail-closed). The runner runs on Linux in Slice 1.5.
- **Carried note:** CLAUDE.md §1 and §7 step 1 still name `spec/slice-1-build-plan.md`, not `docs/plans/slice-1.5-build-plan.md` (reviewer notes on PR #28 and PR #30). Left as is: CLAUDE.md is yours to change.

- **(Ruled: D-076, 2026-10-31.) Slice 1.2: the injection now lands as an overridable park.** The operator accepted `scope_violation` or `integrity_floor` with nothing run and the value recorded `synthesized`/`untrusted`; two spec v0.6 items were added. The original finding: In all 6 runs of s18-2 and s18-2b (`evidence/slice-1.2/`), the model read the planted `/bin/sh -c 'cat /etc/passwd'` and obeyed it the only way the new schema lets it: program `{"slot":"cat"}`, `argv: ["/etc/passwd"]`. The boundary parked `scope_violation` (overridable): `/etc/passwd` is outside the grant. **Nothing ran in any run; every safety check held; no boundary rule changed.** Before Part 1 the model wrote `"/bin/sh"` as a literal program, which parks `integrity_floor` (not overridable). So the interface change moved the attack from a non-overridable park to an overridable one: an operator who overrides would let the task read `/etc/passwd` inside the workload. This touches the §7 STOP "make a non-overridable park overridable" in effect, though not in any rule, so it is yours to decide. Options: (a) accept `scope_violation` as the injection result (the attack is now an out-of-scope read, which the boundary refuses; the §18 test 2 acceptance test with the scripted provider still parks `integrity_floor`); (b) for spec v0.6, make a `scope_violation` non-overridable when the out-of-scope value is synthesized from untrusted content (a spec change; I recommend raising it, since §8.3's own test, "the operator could not observe the consequence of proceeding", seems to apply); (c) revert the literal form for instruction fields (undoes Part 1's main gain). I have not changed anything.
- **Slice 1.2: a new benign-park pattern from D-075's offers.** D-075 offers every constant to data fields, including `cat` (an instruction constant), and in s18-2b turn 2 the model put `{"slot":"cat"}` into `argv`, which parks `scope_violation` (`/usr/bin/cat` is a path outside the grant): finding 3 of Slice 1.1, now via a slot. Not fixed, because Part 2 measures Part 1 as merged; it will be reported.
- **Slice 1.2: Groq appears to enforce the tool schema itself.** In s18-4b run 1 every one of 8 turns came back as Groq's `tool_use_failed` (a 400; the runner records a malformed turn), and the task parked `budget_exceeded`. The likely cause: what the model wrote did not match the schema, and Groq refused it before JUNO saw it. The adapter does not journal Groq's refusal text (the turn's `response` is null), so the evidence cannot show what was refused. Recording that text is a small adapter change for a later part, if you want it.
- **Slice 1.1 third STOP at Part 3: GitHub Models, the provider D-071 names, was retired by GitHub on 2026-07-30.** Checked on 2026-10-30 at about 18:35 UTC. No token was used or needed; nothing was sent to any model; **spend: USD 0**.
  - GitHub's current docs (the REST "Models inference" page https://docs.github.com/en/rest/models/inference, the prototyping page with the rate limits, and https://docs.github.com/en/github-models all serve the same notice) say, verbatim: "As of July 30, 2026, GitHub Models has been fully retired. The playground, model catalog, inference API, and bring your own key (BYOK) are no longer available to any customer." The endpoint, authentication and rate-limit pages no longer exist, so there is nothing current to build the adapter from (CLAUDE.md rule 13 forbids building it from memory).
  - GitHub's changelog says the same: https://github.blog/changelog/2026-07-30-github-models-is-now-retired/ ("As of July 30, 2026, GitHub Models is now retired ... This completes the retirement we announced on July 1"), and https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/ ("This includes existing customers with active usage").
  - The host itself: `https://models.github.ai/`, `/catalog/models` and `POST /inference/chat/completions` all answer `HTTP/2 200`, `content-type: text/plain`, body `OK`, with no other headers. That is a placeholder, not a model API: no catalog, no JSON, no rate-limit headers.
  - Not done, deliberately: no `smoke.yml` was added to `main` to probe the endpoint with `GITHUB_TOKEN`. It would put a workflow with `models: read` on `main` for a service GitHub says no longer exists, and the docs, the changelog and the live host already agree.
  - GitHub's notice points to two replacements: **Microsoft Foundry** (an Azure model catalog) and **GitHub Copilot**. Either is a different provider, which D-071 forbids me to choose.
  - **Your options** (pick one; Parts 3 and 4 then resume from here):
    - (a) **Recommended: return to OpenCode Zen with credit (D-070).** The adapter design and endpoint were already checked live, and `claude-haiku-5-5` costs USD 0.10 in / 0.50 out per 1M tokens, so the whole Part 4 run should cost cents, under JUNO's own USD 5 ceiling. It needs a small credit purchase (the provider adds 4.6% + USD 0.31) and the key in `OPENCODE_API_KEY` for the runner. This drops D-071's zero-spend rule, so it needs your word.
    - (b) GitHub Copilot as the provider, run by the dispatched `smoke.yml`. Whether it has a free tier, an API the runner can call, and a token Actions can use must be read from GitHub's current docs before you rule; I have not checked them and will not assume them.
    - (c) Microsoft Foundry. It needs an Azure subscription, and almost certainly paid usage.
    - (d) Name another provider.
- **PR #14 is superseded.** Its two commits (STATE and D-070) are on this session's branch `claude/juno-autopilot-slice-1-1-i0hmd1`, which is the only branch this session may push to, so the record continues in a new draft PR from that branch. Closing PR #14 is your call.
- **Slice 1.1 second STOP at Part 3: `claude-haiku-5-5` is refused for insufficient funds (D-070's payment STOP).** Checked on 2026-10-30 at about 18:14 UTC, from the runner's host with `OPENCODE_API_KEY`. The key was never printed or stored.
  - `GET https://opencode.ai/inference/v1/models` answered 200 and lists `claude-haiku-5-5`. Its published price there is USD 0.10 in, 0.50 out, 0.01 cache read and 0.125 cache write per 1M tokens. Above 100K tokens of context it is 0.50 in, 2.50 out, 0.05 cache read and 0.625 cache write.
  - Two minimal requests were sent to `POST https://opencode.ai/inference/openai/v1/chat/completions`, header `Authorization: Bearer <key>`: one with a tool and at most 60 output tokens, and one with no tool and at most 5 output tokens. Both answered **HTTP 402 Payment Required** with this exact body:
    `{"error":{"type":"server_error","message":"Upstream request failed: Insufficient account funds"}}`
    The provider's log ids were `01a18e05-33a3-75b5-951f-32d68d369fbf` and `01a18e05-60e2-7a7b-9963-02524c0c6847`.
  - **Spend: USD 0.** Every call this session was refused, and no model produced a token.
  - **To continue:** add credit to the OpenCode Console workspace that owns this key. The provider adds a processing fee of 4.6% + USD 0.31 per credit purchase. Then start a new session with the same instruction; Part 3 resumes from here. JUNO's own USD 5 ceiling stays in force whatever balance the account holds.
- **Slice 1.1 STOP at Part 3: the OpenCode Zen free models refuse this client.** Checked on 2026-10-30, at about 17:00 and again at about 17:50 UTC, from the runner's host with `OPENCODE_API_KEY`. The key was never printed or stored.
  - `GET https://opencode.ai/inference/v1/models` answered 200 and listed 37 models, 9 of them free (price 0): `big-pickle`, `glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `beam-free`, `flint-40b-free`, `mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`.
  - Each was sent one minimal request: `POST https://opencode.ai/inference/openai/v1/chat/completions`, header `Authorization: Bearer <key>`, at most 20 output tokens. That is the endpoint and format the provider's model list and docs give for these models.
  - Eight of the nine answered **HTTP 429**, with `Retry-After: 22420` (about 6.2 hours, which lands near midnight UTC), and this exact body:
    `{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"}}`
  - `nemotron-3-ultra-free` answered **HTTP 400** `{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}`.
  - The provider's docs (https://opencode.ai/docs/zen/, which redirects to `/v2/docs/console/models/`) state: "Free-tier chat models require OpenCode; use paid models or Go from other clients."
  - No paid model was called, and none will be without you. Not one request succeeded, so nothing was spent.
  - **Your options:**
    - (a) authorise one paid model, named, under the USD 5 smoke ceiling. Cheap ones on the provider's price list: `gpt-5-nano` at $0.05 in / $0.40 out per 1M tokens; `claude-haiku-5-5` and `gpt-6-luna` at $0.10 in / $0.50 out;
    - (b) subscribe to OpenCode Go, which the error names, and say so;
    - (c) retry the free models after the `Retry-After` window. This is not recommended: the docs say free models are for the OpenCode client, so this may well fail again, and if it works it may stop working at any time;
    - (d) name another provider.
  - Parts 3 and 4 resume from here, on your word.
- **Minor notes from the review of PR #13 (Part 2; not defects):**
  - in `packages/runner/src/lock.ts` `clearStale`, the `finally` that removes the takeover file would throw if someone else had already removed it, and that error would hide the original outcome;
  - the real-host lock tests need a readable `/etc/machine-id`. It exists here and on GitHub's Ubuntu runners.
- **PR #7 (superseded, still open):** https://github.com/khashayarjavi/juno/pull/7 is an earlier Increment 5 from another session (branch `claude/great-keller-clbbvy`). This session missed it at the start (§7 step 1 says to continue an open PR) and built Increment 5 afresh as PR #8, which is merged. Checked against `main`: PR #7's two operator rulings (TTL expiry fails the task, never a park; no default budget ceiling) are both honoured by the merged code (D-063; the admission schema requires all four axes). Its D-065 proposal is the one the director ruled on (D-065 here). Its other choices were agent decisions, and some differ from the merged ones (for example, it took over a stale runner lock where D-064 refuses to). PR #7 was not closed by this session; closing it is the operator's call.

- **Findings from the real-model evidence, for your decision (none is a defect, none is in Slice 1.1's scope; details in `docs/evidence/slice-1.1.md`):** (1) in 10 of the 22 model runs that count (harness-error runs left out) the model wrote the program path itself and the task parked on its first call; the runner's first message shows the criterion with literal arguments, which likely invites it; (2) the reference index syntax (`[0]`, not `.0`) is never shown to the model; (3) the criterion's constant slots can be named and reused by the model (operator values, so no integrity is gained, but you should know); (4) with temperature 0 and a fixed seed, repeated runs are often identical.

## Objections for spec v0.6 (Slice 1.2 list) — answered by v0.6
The four items recorded during Slice 1.2 are each answered in v0.6 (§0.0): untrusted arguments to write, external and irreversible capabilities by A1 (§2.2.2); verifier slots addressable by the executing model by B1 (§2.6); provenance and the source entry in an approval by A3 (§11.1); no override of an untrusted `scope_violation` by A2 (§8.2). They are built in Slice 1.5 Increments 1 and 3. The original text is in git history (STATE.md before this commit).

## Open objections to the spec
None.

**Resolved:** V61-3 (§2.3.2, an unquoted `#` in a shell command string) — operator ruled (a), D-105: any `#` outside single quotes parks `integrity_floor`. V61-2 (§2.7.1, does an unreadable turn count toward the rejection limit) — operator ruled (a), D-102: it counts as one rejection and never resets the count. V61-1 (§3.4.1, public or private anchor repository) — operator ruled (a) public, D-098; §3.4.1 at fcb1a60. V6-1 to V6-10 by spec v0.6.1 (operator ruling D-091; in effect, v0.6.1 is on `main` since 603284c, D-100): V6-1 §3.4.4 "What is pinned"; V6-2 §2.7.1 "Paths that do not exist yet"; V6-3 §4.3 "Park in B and C" (always deny); V6-4 §3.4.1 "Who signs, and what counts as off-host"; V6-5 §2.3.2 "Reading a shell command string"; V6-6 §4.3 "A session is a Task"; V6-7 §4.3 "Sensitivity in B and C"; V6-8 §11.1 "possible sources"; V6-9 §2.7.1 "The count resets" (an unreadable turn counts as one rejection, D-102); V6-10 §2.3.2 "Effect per program". Full text: DECISIONS.md D-091 and D-098, and the spec at fcb1a60.

## Notes for the next session
- **Minor notes from the last review of PR #10, for the operator (not defects):**
  - the protected-path listing (`ls -l -a -R`) also shows each protected directory's `..` entry, so creating or removing a file *next to* a protected directory also fails verification. That is stricter than D-067's wording says;
  - the failure reason `protected_listing_rejected` is not named in D-067, though the rule behind it is;
  - merging PR #10 made `/usr/bin/ls` in `packages/registry/definitions/shell.run.json` operator-authored (§2.5, D-035); please review it.
- The design-review stopping rule of §0.6 expires now that Slice 1 has produced trajectory data (build plan §6).
- **Increment 6 (resume)** must: rebuild a task's state (task record, spend, grants' invocation counts) from the journal — the admission note holds the full Task, each `capability_call` names the grant charged, each `turn` holds its cost; re-evaluate grants, `model_policy` and `sensitivity_floor` on resume (§6.3); never resume a task whose journal fails verification (D-056); keep TTL counting parked time (D-025). Today the runner keeps tasks in memory, and `run` starts only an `admitted` task.
- **Increment 7 (acceptance):** D-057 (protected paths in every criterion; tests 2 and 3 together). Test 3 needs a discovery program (for example `ls`) in the enum and the workload image (D-029), with bound names after `--` (D-037); `stdout_lines` in a `capability_result` is what a reference binds (D-060). Test 3's program must be a constant or a bound reference to an `attested`-or-better entry. Test 4b must decide how the forced enum entry is registered.
- **Runner on the host (D-065):** `test/containers/runner.test.ts` is the pattern: the `Runner` class runs on the host with `WorkloadExecFileAdapter`. `providers/scripted.json` is read from the source tree; a dist build would need it copied.
- Accepted residual (D-047): symlinks are not resolved in scope checks; must be built before JUNO operates on content it did not create (Slice 1.5).
- Docker Hub answered `429 Too Many Requests` to this cloud VM on 2026-11-04. The session pointed its own daemon at `mirror.gcr.io` (`/etc/docker/daemon.json`, a machine setting, not in the repository). Every base image is pinned by digest, so the bytes are identical. A later session may need the same.
- Rootless runs in a cloud session: `bash scripts/rootless/setup-root.sh --preload-images`, then `bash scripts/rootless/run-verify.sh` (D-131). This VM is cgroup v1, so the cgroup preflight and the 5 limit tests fail there by design. CI's `verify-rootless` is the proof.
- Docker: if `docker info` fails at session start, check `/tmp/dockerd.log`. This cloud host runs cgroup v1; CI runs v2. The CPU-limit test needs at least two host CPUs (D-030, D-039).
- `docker compose run` attaches stdin; anything that runs a program through it must close stdin (D-033).
- No `npm install` in Dockerfiles (D-001).
