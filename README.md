# JUNO

A governance layer for AI agents. JUNO checks every action an agent takes against permissions the operator signs in advance (Grants), blocks or parks what isn't allowed, and records everything in a tamper-evident journal.

**Current stage:** Slice 1 — proving the enforcement boundary is in the right place. See `STATE.md` for exact progress.

| Start here | Who it's for |
|---|---|
| `CLAUDE.md` | The coding agent's rules |
| `STATE.md` | Where the build is right now |
| `DECISIONS.md` | Decisions made during the build |
| `spec/` | The specification and the build plan (read-only) |
| `docs/operator-setup.md` | Setting JUNO up on your Windows machine, part by part (Slice 1.5) |
| `docs/evidence/slice-1.5.md` | What Slice 1.5 proves, and what it does not protect |
| `docs/operator-runbook.md` | What the operator does |
| `docs/session-prompts.md` | Prompts to paste into Claude Code |

**Verification:** `make verify` (created in Increment 0) runs typecheck → lint → unit tests → container build. CI runs it on every pull request.
