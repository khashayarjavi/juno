# JUNO

JUNO is a governance layer for AI agents. Before an agent's action runs, JUNO checks it against permissions its operator signed in advance (**grants**). It lets through what a grant allows, blocks or **parks** (holds for the operator) what it does not, and records every decision in a **tamper-evident journal** whose heads are copied off the machine.

## What JUNO is, and what it is not

**It is:**
- **An enforcement boundary** that sits between an agent and its effects. It governs three ways in (spec §4.3): JUNO's own agent loop (mode A); Claude Code, through a hook Claude Code cannot turn off (mode C); and an MCP server, behind JUNO's gateway (mode B).
- **Authority from one key only.** A grant counts only if the operator's key signed it, and that key is kept off the machine except while signing. A tampered, foreign or unsigned grant is refused.
- **A journal you can check yourself.** Every decision is hash-chained, and the chain heads are pushed to a public git repository the operator owns. `juno journal check` and `juno journal report` verify a copy of the journal against that repository from a separate account.
- **Fail-closed.** When JUNO cannot decide, it blocks. Some parks, such as an injected shell command, cannot be overridden by anyone.

**It is not:**
- an agent, a model, or a prompt filter: it judges what an agent **asks to do**, never what it thinks;
- a sandbox for whatever an allowed program then does with its inputs;
- protection for a session it never sees: a Claude Code run started outside the governed terminal is not governed;
- protection against a compromised host beyond what signing and anchoring cover (a kernel or container escape, or someone who takes over the runner's account);
- finished software: there is no console, no approval interface, and no multi-user setup yet.

## Status

**Slice 1.5, with one real install.** Slice 1 proved the enforcement boundary is in the right place (spec §18's five acceptance tests). Slice 1.5 governs Claude Code and MCP on a real Windows machine with WSL2, and is in use on exactly one install: the operator's. Fixes from that install's field reports land as small increments (`STATE.md` says where the build is now).

Every change is accepted only when `make verify` (typecheck, lint, unit tests, then sealed containers) is green in CI, and after an independent review. The project is built by a coding agent under the rules in `CLAUDE.md`. Every decision not already in the spec is recorded, with its reason, in `DECISIONS.md`.

## The threat model, in short

- **The agent is not trusted.** Anything it wrote, read or was steered by is *untrusted*. Untrusted content may choose what a write says, but not where it goes, except inside a folder you made reversible (checkpointed first, and restorable). It never chooses an outside recipient, an irreversible target, or which program runs. See spec §2.2.2, and the table in `docs/evidence/slice-1.5.md`.
- **Your key and your Windows account are trusted.** Authority comes only from grants your key signed; your Windows account is trusted like that key.
- **Root and the runner's account are inside the boundary.** The services run as a dedicated runner user. Whoever takes it over can disturb JUNO on that machine. They cannot sign a grant, and they cannot erase anchored history without trace: your own check from another account shows it.
- **What JUNO cannot see, it cannot govern.** Each mode's limits are listed plainly, with every known residual, in `docs/evidence/slice-1.5.md` ("What each mode does not protect").

## Where to read on

| Document | What it holds |
|---|---|
| [`spec/core-semantic-model.md`](spec/core-semantic-model.md) | The specification (read-only): the model JUNO is built from |
| [`docs/evidence/slice-1.5.md`](docs/evidence/slice-1.5.md) | What Slice 1.5 proves, where each property is proven, what each mode does not protect, and every residual |
| [`docs/evidence/`](docs/evidence/) | The evidence for earlier slices |
| [`docs/operator-setup.md`](docs/operator-setup.md) | Setting JUNO up on Windows with WSL2, step by step, with a check after each step |
| [`STATE.md`](STATE.md) | Where the build is right now |
| [`DECISIONS.md`](DECISIONS.md) | Every decision made during the build, with its reason |
| [`CLAUDE.md`](CLAUDE.md) | The rules the coding agent works under |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability privately |

**Verification:** `make verify` runs typecheck, then lint, then the unit tests, then the container build and the container tests. CI runs it, and the rootless runs the operator's machine uses, on every pull request.

**License:** none has been chosen yet. Until one is, no licence is granted to use, copy or modify this code.
